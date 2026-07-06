import jsforce from 'jsforce';
import JSZip from 'jszip';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({}); 

export const handler = async (event) => {
    for (const record of event.Records) {
        const body = JSON.parse(record.body);
        const recordId = body.recordId;
        const objectType = body.objectType;
        const orgName = body.orgName;

        if (recordId) {
            const safeRecordId = getSafeString(recordId);
            const safeObjectType = getSafeString(objectType);
            const safeOrgName = getSafeString(orgName);
            await processZipping(safeObjectType, safeRecordId, safeOrgName);
        }
    }
};

function getSafeString(input) {
    return String(input).replace(/'/g, "\\'");
}

async function processZipping(safeObjectType, safeRecordId, safeOrgName) {
    let conn; 
    try {
        conn = await getSalesforceConnection(safeOrgName);
        console.log('Successfully authenticated to Salesforce Org');

        // 1. Fetch ContentDocumentIds linked to the record
        const uniqueDocIds = await fetchLinkedDocumentIds(conn, safeRecordId);
        if (!uniqueDocIds.length) {
            throw new Error('No file attachments found linked to this PayPeriod.');
        }

        // 2. Fetch the ContentVersion records, only PDFs
        const contentVersions = await fetchContentVersions(conn, uniqueDocIds);
        if (!contentVersions.length) {
            throw new Error('No valid PDF data sheets found.');
        }

        // 3. Download the files from Salesforce and compile into a ZIP
        const zip = new JSZip();
        await compileZipArchive(conn, contentVersions, zip);

        const totalCompressedFiles = Object.keys(zip.files).length;
        if (totalCompressedFiles === 0) {
            throw new Error('ZIP compilation halted: Empty collection.');
        }

        // 4. Generate the ZIP buffer and locate S3 structure configs
        const zipBuffer = await zip.generateAsync({ 
            type: 'nodebuffer', 
            compression: 'DEFLATE', 
            compressionOptions: { level: 6 } 
        });
        
        const { s3Key } = getS3TargetDetails(safeObjectType, safeRecordId);

        // 5. Upload payload bundle into target AWS S3 bucket
        await uploadZipToS3(zipBuffer, s3Key);
        console.log('# S3 upload successful');

        // 6. Report successful operation sync updates back to Salesforce
        const successMessage = `Successfully processed and packed ${totalCompressedFiles} payslips into S3 storage.`;
        await updateSalesforceStatus(conn, safeObjectType, safeRecordId, 'Success', successMessage);

    } catch (error) {
        console.error('# Background Processing Exception:', error);
        if (conn) {
            const failureMessage = `Failure Context: ${error.message}`;
            await updateSalesforceStatus(conn, safeObjectType, safeRecordId, 'Error', failureMessage);
        }
    }
}

async function getSalesforceConnection(orgName) {
    let clientId;
    let clientSecret;
    let loginUrl;

    if(orgName === 'Production') {
        clientId = process.env.SF_PROD_CLIENT_ID;
        clientSecret = process.env.SF_PROD_CLIENT_SECRET;
        loginUrl = process.env.SF_PROD_LOGIN_URL || 'https://login.salesforce.com';
    }else{
        clientId = process.env.SF_SANDBOX_CLIENT_ID;
        clientSecret = process.env.SF_SANDBOX_CLIENT_SECRET;
        loginUrl = process.env.SF_SANDBOX_LOGIN_URL || 'https://test.salesforce.com';
    }

    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
    });
    
    const response = await fetch(`${loginUrl}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });
    
    if (!response.ok) throw new Error(`Salesforce Auth Failed: ${response.statusText}`);
    const tokenData = await response.json();
    return new jsforce.Connection({ instanceUrl: tokenData.instance_url, accessToken: tokenData.access_token });
}

async function fetchLinkedDocumentIds(conn, safeRecordId) {
    const docIds = [];
    const linkQuery = `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${safeRecordId}'`;
    
    let linkResult = await conn.query(linkQuery);
    linkResult.records.forEach(r => docIds.push(r.ContentDocumentId));
    
    while (!linkResult.done) {
        linkResult = await conn.queryMore(linkResult.nextRecordsUrl);
        linkResult.records.forEach(r => docIds.push(r.ContentDocumentId));
    }
    
    return [...new Set(docIds)].filter(id => id);
}

async function fetchContentVersions(conn, uniqueDocIds) {
    const contentVersions = [];
    const chunkSize = 500;
    
    for (let i = 0; i < uniqueDocIds.length; i += chunkSize) {
        const chunkIds = uniqueDocIds.slice(i, i + chunkSize);
        const docIdsString = chunkIds.map(id => `'${id}'`).join(',');
        
        let cvQuery = `
            SELECT Id, Title, FileExtension, VersionData
            FROM ContentVersion
            WHERE ContentDocumentId IN (${docIdsString}) AND FileType = 'PDF' AND IsLatest = true
        `;
        
        let cvResult = await conn.query(cvQuery);
        contentVersions.push(...cvResult.records);
        
        while (!cvResult.done) {
            cvResult = await conn.queryMore(cvResult.nextRecordsUrl);
            contentVersions.push(...cvResult.records);
        }
    }
    return contentVersions;
}

async function compileZipArchive(conn, contentVersions, zip) {
    const CONCURRENCY_LIMIT = 30;

    for (let i = 0; i < contentVersions.length; i += CONCURRENCY_LIMIT) {
        const poolChunk = contentVersions.slice(i, i + CONCURRENCY_LIMIT);
        
        await Promise.all(poolChunk.map(file => 
            downloadSingleFile(conn, file)
                .then(({ fileName, buffer }) => {
                    zip.file(fileName, buffer, { binary: true });
                })
                .catch(err => {
                    console.error(`Skipped file ID ${file.Id}:`, err.message);
                })
        ));
    }
}

async function downloadSingleFile(conn, file) {
    const finalFileName = sanitizeFileName(file);
    const fileUrl = `${conn.instanceUrl}${file.VersionData}`;
    
    const response = await fetch(fileUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${conn.accessToken}` }
    });

    if (!response.ok) throw new Error(`HTTP Error Status ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    return {
        fileName: finalFileName,
        buffer: Buffer.from(arrayBuffer)
    };
}

function sanitizeFileName(file) {
    let rawTitle = file.Title ? file.Title.trim() : 'Payslip';
    let cleanTitle = rawTitle.replace(/[\/\\?%*:|"<>]/g, '-');
    let finalFileName = `${cleanTitle}_${file.Id}.${file.FileExtension}`;
    
    if (finalFileName.includes('/')) {
        finalFileName = finalFileName.substring(finalFileName.lastIndexOf('/') + 1);
    }
    return finalFileName;
}

function getS3TargetDetails(safeObjectType, safeRecordId) {
    const objectName = safeObjectType === 'Pay_Period__c' ? 'PayPeriod' : safeObjectType;
    const zipTitle = `Payslips_${safeRecordId}.zip`;
    return {
        zipTitle,
        s3Key: `exports/${objectName}/${zipTitle}`
    };
}

async function uploadZipToS3(zipBuffer, s3Key) {
    await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_PAYSLIP_BUCKET,
        Key: s3Key,
        Body: zipBuffer,
        ContentType: 'application/zip'
    }));
}

async function updateSalesforceStatus(conn, safeObjectType, safeRecordId, status, message) {
    try {
        await conn.sobject(safeObjectType).update({
            Id: safeRecordId,
            Payslip_Zip_Status__c: status,
            AWS_Response__c: message
        });
    } catch (sfErr) {
        console.error('Failed log writeback to Salesforce:', sfErr);
    }
}