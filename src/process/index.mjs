import jsforce from 'jsforce';
import JSZip from 'jszip';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({}); 

export const handler = async (event) => {
    for (const record of event.Records) {
        const body = JSON.parse(record.body);
        const recordId = body.recordId;
        const objectType = body.objectType;

        if (recordId) {
            const safeRecordId = String(recordId).replace(/'/g, "\\'");
            const safeObjectType = String(objectType).replace(/'/g, "\\'");
            await processZipping(safeObjectType, safeRecordId);
        }
    }
};

async function processZipping(safeObjectType, safeRecordId) {
    let conn; 
    try {
        conn = await getSalesforceConnection();
        console.log('Successfully authenticated to Salesforce Org');

        let docIds = [];
        let linkQuery = `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${safeRecordId}'`;
        
        let linkResult = await conn.query(linkQuery);
        linkResult.records.forEach(r => docIds.push(r.ContentDocumentId));
        
        while (!linkResult.done) {
            linkResult = await conn.queryMore(linkResult.nextRecordsUrl);
            linkResult.records.forEach(r => docIds.push(r.ContentDocumentId));
        }

        const uniqueDocIds = [...new Set(docIds)].filter(id => id);
        if (!uniqueDocIds.length) throw new Error('No file attachments found linked to this PayPeriod.');

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

        if (!contentVersions.length) throw new Error('No valid PDF data sheets found.');

        const zip = new JSZip();
        const CONCURRENCY_LIMIT = 30;

        const downloadFile = async (file) => {
            let rawTitle = file.Title ? file.Title.trim() : 'Payslip';
            let cleanTitle = rawTitle.replace(/[\/\\?%*:|"<>]/g, '-');
            let finalFileName = `${cleanTitle}_${file.Id}.${file.FileExtension}`;
            
            if (finalFileName.includes('/')) {
                finalFileName = finalFileName.substring(finalFileName.lastIndexOf('/') + 1);
            }

            const fileUrl = `${conn.instanceUrl}${file.VersionData}`;
            const response = await fetch(fileUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${conn.accessToken}` }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const arrayBuffer = await response.arrayBuffer();
            zip.file(finalFileName, Buffer.from(arrayBuffer), { binary: true });
        };

        for (let i = 0; i < contentVersions.length; i += CONCURRENCY_LIMIT) {
            const poolChunk = contentVersions.slice(i, i + CONCURRENCY_LIMIT);
            await Promise.all(poolChunk.map(file => downloadFile(file).catch(err => {
                console.error(`Skipped file ID ${file.Id}:`, err.message);
            })));
        }

        const totalCompressedFiles = Object.keys(zip.files).length;
        if (totalCompressedFiles === 0) throw new Error('ZIP compilation halted: Empty collection.');

        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const objectName = safeObjectType == 'PayPeriod__c' ? 'PayPeriod' : safeObjectType;
        const zipTitle = `${objectName}_Payslips_${safeRecordId}.zip`;
        
        // Target Key structure used by CloudFront delivery routes
        const s3Key = `exports/${zipTitle}`;

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_PAYSLIP_BUCKET,
            Key: s3Key,
            Body: zipBuffer,
            ContentType: 'application/zip'
        }));

        console.log('# S3 upload successful');

        await conn.sobject(safeObjectType).update({
            Id: safeRecordId,
            Payslip_Zip_Status__c: 'Success',
            AWS_Response__c: `Successfully processed and packed ${totalCompressedFiles} payslips into S3 storage.`
        });

    } catch (error) {
        console.error('# Background Processing Exception:', error);
        if (conn) {
            try {
                await conn.sobject(safeObjectType).update({
                    Id: safeRecordId,
                    Payslip_Zip_Status__c: 'Error',
                    AWS_Response__c: `Failure Context: ${error.message}`
                });
            } catch (sfErr) {
                console.error('Failed log writeback to SF:', sfErr);
            }
        }
    }
}

async function getSalesforceConnection() {
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET
    });
    const response = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });
    if (!response.ok) throw new Error(`Salesforce Auth Failed: ${response.statusText}`);
    const tokenData = await response.json();
    return new jsforce.Connection({ instanceUrl: tokenData.instance_url, accessToken: tokenData.access_token });
}
