import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs'; 
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';

declare const __dirname: string;

export class PayslipPipelineInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Private Target Storage S3 Bucket 
    const archiveBucket = new s3.Bucket(this, 'SecurePayslipZipBucket', {
      bucketName: `payslip-zips-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
      lifecycleRules: [
        {
          id: 'AutoPurgeContactExportsAfterOneMonth',
          enabled: true,
          prefix: 'exports/Contact/', // Targets objects inside the virtual Contact folder tree
          expiration: Duration.days(30), // Automatically drops items after 30 days
        },
        {
          id: 'AutoPurgePayPeriodExportsAfterOneMonth',
          enabled: true,
          prefix: 'exports/PayPeriod/', // Targets objects inside the virtual PayPeriod folder tree
          expiration: Duration.days(30),
        }
      ]
    });

    // 2. Asynchronous Decoupling SQS Queue with a Dead-Letter Queue (DLQ)
    const deadLetterQueue = new sqs.Queue(this, 'ZippingPipelineDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const workQueue = new sqs.Queue(this, 'ZippingPipelineQueue', {
      visibilityTimeout: cdk.Duration.minutes(15), 
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: deadLetterQueue,
      },
    });

    // 3. Setup Modern CloudFront Origin Access Control (OAC)
    const cloudFrontOAC = new cloudfront.CfnOriginAccessControl(this, 'S3ZipDeliveryOAC', {
      originAccessControlConfig: {
        name: 'SecureS3ZipStorageOACConfig',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    // 4. Create CloudFront CDN Distribution referencing our Private S3 Origin Bucket
    const cdnDistribution = new cloudfront.Distribution(this, 'ZipDownloadCDN', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(archiveBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // Patch CloudFront property overrides to force modern OAC authorization handshakes natively
    const cfnDistributionResource = cdnDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistributionResource.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', cloudFrontOAC.attrId);
    cfnDistributionResource.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');

    // Allow CloudFront OAC principal exclusive permissions to read out objects from S3
    archiveBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [archiveBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${cdnDistribution.distributionId}`,
        },
      },
    }));

    // 5. Build Entry Lambda function ('init payslip zip')
    const initLambda = new lambda.Function(this, 'InitPayslipZipFunction', {
      functionName: 'init-payslip-zip_iac',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler', 
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/init')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        SQS_QUEUE_URL: workQueue.queueUrl,
      },
    });

    // Give entry Lambda permissions to send payloads to the queue
    workQueue.grantSendMessages(initLambda);

    // 6. Build Background Processing Lambda Worker ('process payslip zip')
    const processLambda = new lambdaNodejs.NodejsFunction(this, 'ProcessPayslipZipFunction', {
      functionName: 'process-payslip-zip-iac',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../src/process/index.mjs'),
      handler: 'handler', 
      timeout: cdk.Duration.minutes(15), 
      memorySize: 2048,                 
      environment: {
        AWS_PAYSLIP_BUCKET: archiveBucket.bucketName,
        SF_PROD_LOGIN_URL: process.env.SF_PROD_LOGIN_URL || '',
        SF_PROD_CLIENT_ID: process.env.SF_PROD_CLIENT_ID || '',
        SF_PROD_CLIENT_SECRET: process.env.SF_PROD_CLIENT_SECRET || '',
        SF_SANDBOX_LOGIN_URL: process.env.SF_SANDBOX_LOGIN_URL || '',
        SF_SANDBOX_CLIENT_ID: process.env.SF_SANDBOX_CLIENT_ID || '',
        SF_SANDBOX_CLIENT_SECRET: process.env.SF_SANDBOX_CLIENT_SECRET || ''
      },
      bundling: {
        minify: true, 
        sourceMap: true,
        forceDockerBundling: false
      }
    });

    // Provide background worker rights to write back elements straight onto S3 and pick up queue streams
    archiveBucket.grantWrite(processLambda);
    processLambda.addEventSource(new lambdaEventSources.SqsEventSource(workQueue, {
      batchSize: 1, 
    }));

    // 7. Wire up API Gateway HTTP API wrapper layer over entry Lambda
    const httpApiGateway = new apigatewayv2.HttpApi(this, 'PayslipPipelineHttpGateway', {
      apiName: 'PayslipZipWebhookGateway',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST],
      },
    });

    const apiIntegration = new apigatewayv2Integrations.HttpLambdaIntegration('InitLambdaIntegration', initLambda);
    httpApiGateway.addRoutes({
      path: '/init-zip',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    // --- Output ---
    new cdk.CfnOutput(this, 'ApiGatewayWebhookUrl', {
      value: `${httpApiGateway.apiEndpoint}/init-zip`,
      description: 'The secure processing entry webhook URL to configure within Salesforce Apex callout classes.',
    });

    new cdk.CfnOutput(this, 'CloudFrontDownloadDomain', {
      value: cdnDistribution.distributionDomainName,
      description: 'The secure CDN base address domain name path pattern to fetch files inside your LWC custom dashboard.',
    });
  }
}