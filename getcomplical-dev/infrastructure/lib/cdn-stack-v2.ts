import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export class CdnStackV2 extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get API Gateway ID from SSM
    const apiGatewayId = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/api/gateway-id'
    );
    
    // Get CloudFront secret from SSM
    const cloudfrontSecretArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/secrets/cloudfront-api/arn'
    );

    // Get WAF Web ACL ARN from SSM (if exists)
    // Note: This will be a token, so we can't use it in conditional logic
    const webAclArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/waf/webacl-arn'
    );

    // Create S3 bucket for CloudFront logs
    const logsBucket = new s3.Bucket(this, 'CloudFrontLogs', {
      bucketName: `getcomplical-cloudfront-logs-v2-${this.account}-${this.region}`,
      lifecycleRules: [{
        id: 'delete-old-logs',
        enabled: true,
        expiration: cdk.Duration.days(30),
      }],
      // CloudFront requires ACLs to be enabled for logging
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: true,
        ignorePublicAcls: false,
        restrictPublicBuckets: true,
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // Construct API domain name from the gateway ID
    const apiDomainName = `${apiGatewayId}.execute-api.${this.region}.amazonaws.com`;

    // Import the CloudFront secret
    const cloudfrontSecret = cdk.SecretValue.secretsManager(cloudfrontSecretArn, {
      jsonField: 'headerValue',
    });

    // Create CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'GetComplical API Distribution',
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiDomainName, {
          originPath: '/v1',
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: {
            'X-CloudFront-Secret': cloudfrontSecret.unsafeUnwrap(),
          },
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomainName, {
            originPath: '/v1',
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: {
              'X-CloudFront-Secret': cloudfrontSecret.unsafeUnwrap(),
            },
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
            minTtl: cdk.Duration.seconds(0),
            maxTtl: cdk.Duration.minutes(5),
            defaultTtl: cdk.Duration.minutes(1),
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
              'X-Api-Key',
              'Authorization',
              'Content-Type',
            ),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
          }),
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/health': {
          origin: new origins.HttpOrigin(apiDomainName, {
            originPath: '/v1',
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: {
              'X-CloudFront-Secret': cloudfrontSecret.unsafeUnwrap(),
            },
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: 'api-access-logs/',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Note: WAF association might fail if the WAF is not in us-east-1
      // webAclId: webAclArn, // Commented out due to cross-region limitations
    });

    // Export CloudFront distribution info to SSM
    new ssm.StringParameter(this, 'DistributionIdParam', {
      parameterName: '/getcomplical/cdn/distribution-id',
      stringValue: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new ssm.StringParameter(this, 'DistributionDomainParam', {
      parameterName: '/getcomplical/cdn/distribution-domain',
      stringValue: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    // Outputs
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront Distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
    });

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL',
    });
  }
}