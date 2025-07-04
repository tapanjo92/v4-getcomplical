import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

interface CdnStackProps extends cdk.StackProps {
  apiGateway: apigateway.RestApi;
}

export class CdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    const apiDomainName = `${props.apiGateway.restApiId}.execute-api.${this.region}.amazonaws.com`;

    // Separate cache policies for different query patterns
    const popularQueriesCachePolicy = new cloudfront.CachePolicy(this, 'PopularQueriesCache', {
      cachePolicyName: 'GetComplicalPopularQueries',
      comment: 'Long TTL for popular country+year queries',
      defaultTtl: cdk.Duration.hours(24),
      maxTtl: cdk.Duration.days(7),
      minTtl: cdk.Duration.hours(12),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList(['country', 'year']),
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
          originPath: '/v1',
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
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/dashboard/*': {
          origin: new origins.HttpOrigin(apiDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originPath: '/v1',
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Enable logging for cache analysis
      enableLogging: true,
      logBucket: new cdk.aws_s3.Bucket(this, 'CdnLogs', {
        bucketName: `getcomplical-cdn-logs-${this.account}`,
        lifecycleRules: [{
          expiration: cdk.Duration.days(30),
        }],
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      }),
    });

    // CloudWatch metrics for cache performance
    new cloudfront.CfnRealtimeLogConfig(this, 'RealtimeLogConfig', {
      name: 'GetComplicalCacheAnalytics',
      endPoints: [{
        streamType: 'Kinesis',
        kinesisStreamConfig: {
          roleArn: new cdk.aws_iam.Role(this, 'LogRole', {
            assumedBy: new cdk.aws_iam.ServicePrincipal('cloudfront.amazonaws.com'),
          }).roleArn,
          streamArn: new cdk.aws_kinesis.Stream(this, 'LogStream', {
            streamName: 'getcomplical-cache-logs',
            retentionPeriod: cdk.Duration.days(1),
          }).streamArn,
        },
      }],
      fields: [
        'timestamp',
        'c-ip',
        'sc-status',
        'cs-uri-query',
        'x-edge-result-type', // Hit, Miss, Error
        'x-edge-response-result-type',
        'cs-protocol',
        'cs-bytes',
        'time-taken',
        'x-forwarded-for',
        'cs-method',
        'cs-host',
        'cs-uri-stem',
      ],
      samplingRate: 100, // Log all requests initially to understand patterns
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'CachePolicyInfo', {
      value: 'Popular queries (country+year): 24h TTL, Filtered queries (with type): 6h TTL',
      description: 'Cache policy configuration',
    });
  }
}