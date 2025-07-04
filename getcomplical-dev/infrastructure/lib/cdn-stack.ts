import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface CdnStackProps extends cdk.StackProps {
  apiGateway: apigateway.RestApi;
}

export class CdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    const apiDomainName = `${props.apiGateway.restApiId}.execute-api.${this.region}.amazonaws.com`;

    // Create S3 bucket for CloudFront logs with unique name
    const logBucket = new s3.Bucket(this, 'CdnLogsBucket', {
      bucketName: `getcomplical-cdn-logs-${this.account}-${this.region}`,
      lifecycleRules: [{
        expiration: cdk.Duration.days(30),
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: true,
        ignorePublicAcls: false,
        restrictPublicBuckets: true,
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Separate cache policies for different query patterns
    const popularQueriesCachePolicy = new cloudfront.CachePolicy(this, 'PopularQueriesCache', {
      cachePolicyName: 'GetComplicalPopularQueries',
      comment: 'Long TTL for popular country+year queries',
      defaultTtl: cdk.Duration.hours(24),
      maxTtl: cdk.Duration.days(7),
      minTtl: cdk.Duration.hours(12),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('country', 'year'),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('X-Api-Key'),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const filteredQueriesCachePolicy = new cloudfront.CachePolicy(this, 'FilteredQueriesCache', {
      cachePolicyName: 'GetComplicalFilteredQueries',
      comment: 'Shorter TTL for filtered queries with type parameter',
      defaultTtl: cdk.Duration.hours(6),
      maxTtl: cdk.Duration.hours(24),
      minTtl: cdk.Duration.hours(1),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('X-Api-Key'),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: 'GetComplical Tax API CDN',
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiDomainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: filteredQueriesCachePolicy, // Default for all queries
        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
          originRequestPolicyName: 'GetComplicalApiOriginRequest',
          comment: 'Forward API key header and all query strings',
          queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('X-Api-Key'),
          cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        }),
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'ApiResponseHeaders', {
          responseHeadersPolicyName: 'GetComplicalApiHeaders',
          comment: 'Add cache status headers',
          customHeadersBehavior: {
            customHeaders: [
              {
                header: 'X-Cache-TTL',
                value: '6h-filtered',
                override: false,
              },
            ],
          },
          corsBehavior: {
            accessControlAllowOrigins: ['*'],
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
            accessControlAllowCredentials: false,
            accessControlMaxAge: cdk.Duration.seconds(86400),
            originOverride: true,
          },
        }),
      },
      additionalBehaviors: {
        '/api/v1/tax-dates': {
          origin: new origins.HttpOrigin(apiDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originPath: '/v1',
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Smart caching: Use Lambda@Edge to route to appropriate cache
          cachePolicy: filteredQueriesCachePolicy,
          originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'TaxDatesOriginRequestPolicy', {
            originRequestPolicyName: 'GetComplicalTaxDatesOriginRequest',
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('X-Api-Key'),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
          }),
        },
        '/v1/dashboard/*': {
          origin: new origins.HttpOrigin(apiDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Enable standard CloudFront logging
      enableLogging: true,
      logBucket: logBucket,
      logFilePrefix: 'cloudfront-logs/',
      logIncludesCookies: false,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'LogBucketName', {
      value: logBucket.bucketName,
      description: 'S3 bucket for CloudFront logs',
    });

    new cdk.CfnOutput(this, 'CachePolicyInfo', {
      value: 'Popular queries (country+year): 24h TTL, Filtered queries (with type): 6h TTL',
      description: 'Cache policy configuration',
    });
  }
}