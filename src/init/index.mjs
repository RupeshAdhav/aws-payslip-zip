import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({});

export const handler = async (event) => {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
    const recordId = body.recordId;
    const objectType = body.objectType;

    if (!objectType || !recordId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing objectType or recordId' }) 
        };
    }

    await sqsClient.send(new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ recordId: recordId, objectType: objectType })
    }));

    return {
        statusCode: 200,
        body: JSON.stringify({ 
            success: true, 
            message: 'Zipping operation has been successfully started.' 
        })
    };
};