import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path'; // <--- FIX 1: Resolves 'path' error
import { fileURLToPath } from 'url';

// FIX 2: Resolves '__dirname' error regardless of module type
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SecurePdfDistributionInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Provision the Target Storage System Private S3 Bucket
    const archiveBucket = new s3.Bucket(this, 'SecureArchiveBucket', {
      bucketName: `secure-payslip-zips-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // strict zero public exposure access paths
      removalPolicy: cdk.RemovalPolicy.DESTROY,          // change to RETAIN if moving onto production targets
      autoDeleteObjects: true,
    });

    // 2. Setup Modern CloudFront Origin Access Control (OAC) to replace legacy OAI
    const cloudFrontOAC = new cloudfront.CfnOriginAccessControl(this, 'CloudFrontOAC', {
      originAccessControlConfig: {
        name: 'SecureS3ZipStorageOAC',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    // 3. Create CloudFront CDN Distribution referencing our Private S3 Origin
    const cdnDistribution = new cloudfront.CloudFrontWebDistribution(this, 'ZipDeliveryCDN', {
      originConfigs: [
        {
          s3OriginSource: {
            s3BucketSource: archiveBucket,
          },
          behaviors: [
            {
              isDefaultBehavior: true,
              allowedMethods: cloudfront.CloudFrontAllowedMethods.GET_HEAD,
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              // Note: Change to 'true' if enforcing CloudFront Trusted Key Groups / Signed URL verification rules
              trustedSigners: undefined, 
            },
          ],
        },
      ],
    });

    // Patch CloudFront allocation properties to bridge OAC configuration settings natively via L1 constructs
    const cfnDistributionResource = cdnDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistributionResource.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', cloudFrontOAC.attrId);
    cfnDistributionResource.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');

    // 4. Attach Bucket IAM Policy allowing strict read data parsing actions out to CloudFront OAC principal
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

    // 5. Instantiate Your Target Processing Execution Lambda Function
    const processingLambda = new lambda.Function(this, 'PdfZippingProcessorEngine', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../src')),
      timeout: cdk.Duration.minutes(5), // Elevate execution overhead to allow processing large multi-file transformations
      memorySize: 1024,
      environment: {
        S3_BUCKET_NAME: archiveBucket.bucketName,
      },
    });

    // Grant exclusive resource write permissions to the Lambda processing role instances
    archiveBucket.grantWrite(processingLambda);

    // 6. Deploy API Gateway Endpoint Wrapper targeting the Lambda instance
    const restApiInterface = new apigateway.LambdaRestApi(this, 'ZippingEngineGatewayEndpoint', {
      handler: processingLambda,
      proxy: false,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // restrict to target domain paths if calling from web layout containers directly
        allowMethods: apigateway.Cors.ALL_METHODS,
      }
    });

    // Define standard routing paths
    const zippingResourceTarget = restApiInterface.root.addResource('start-zipping');
    zippingResourceTarget.addMethod('POST'); // POST /start-zipping maps to engine loop processing execution 

    // --- Output Parameters Manifest Mappings ---
    new cfnOutput(this, 'ApiGatewayEndpointUrl', {
      value: restApiInterface.url,
      description: 'The secure processing entry API gateway string address to input into Salesforce Custom Metadata settings mappings.',
    });

    new cfnOutput(this, 'CloudFrontDistributionDomain', {
      value: cdnDistribution.distributionDomainName,
      description: 'The structural base domain address path mapping out distribution targets over CDN processing streams.',
    });
  }
}

// Utility subclass configuration patch helper pattern required to capture and surface CfnOutput namespaces safely
class cfnOutput extends cdk.CfnOutput {}