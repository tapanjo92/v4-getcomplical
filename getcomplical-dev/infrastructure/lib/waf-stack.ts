import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kinesisfirehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface WafStackProps extends cdk.StackProps {
  // We'll receive the CloudFront distribution ARN from CDN stack
}

export class WafStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly webAclId: string;
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props?: WafStackProps) {
    super(scope, id, props);

    // Create S3 bucket for WAF logs with intelligent tiering
    const wafLogsBucket = new s3.Bucket(this, 'WafLogsBucket', {
      bucketName: `getcomplical-waf-logs-${this.account}-${this.region}`,
      lifecycleRules: [{
        id: 'IntelligentTiering',
        transitions: [
          {
            storageClass: s3.StorageClass.INTELLIGENT_TIERING,
            transitionAfter: cdk.Duration.days(0), // Immediate intelligent tiering
          },
          {
            storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
            transitionAfter: cdk.Duration.days(90),
          },
        ],
        expiration: cdk.Duration.days(365), // Keep logs for 1 year
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      eventBridgeEnabled: true, // Enable for future real-time processing
    });

    // Create IAM role for Kinesis Firehose
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Role for WAF logs Kinesis Firehose delivery stream',
    });

    // Grant Firehose permissions to write to S3
    wafLogsBucket.grantWrite(firehoseRole);

    // Create CloudWatch log group for Firehose errors
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: '/aws/kinesisfirehose/getcomplical-waf',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    firehoseLogGroup.grantWrite(firehoseRole);

    // Create Kinesis Firehose delivery stream with advanced configuration
    const deliveryStream = new kinesisfirehose.CfnDeliveryStream(this, 'WafLogsDeliveryStream', {
      deliveryStreamName: 'aws-waf-logs-getcomplical',
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: wafLogsBucket.bucketArn,
        prefix: 'waf-logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/',
        errorOutputPrefix: 'waf-logs-errors/',
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'GZIP',
        bufferingHints: {
          intervalInSeconds: 300, // 5 minutes
          sizeInMBs: 5,
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: 'S3Delivery',
        },
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'MetadataExtraction',
            parameters: [{
              parameterName: 'MetadataExtractionQuery',
              parameterValue: '{country:.httpRequest.country,action:.action}',
            }, {
              parameterName: 'JsonParsingEngine',
              parameterValue: 'JQ-1.6',
            }],
          }],
        },
        dataFormatConversionConfiguration: {
          enabled: false, // Keep as JSON for now, can enable Parquet later
        },
      },
    });

    // Create the Web ACL with comprehensive rules
    this.webAcl = new wafv2.CfnWebACL(this, 'GetComplicalWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      name: 'GetComplicalAPIProtection',
      description: 'Advanced WAF protection for GetComplical Tax API',
      rules: [
        // Rule 1: IP-based rate limiting (DDoS protection)
        {
          name: 'IPRateLimit',
          priority: 1,
          action: { 
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: 'RateLimitExceeded',
              },
            },
          },
          statement: {
            rateBasedStatement: {
              limit: 2000, // 2000 requests per 5 minutes per IP
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'IPRateLimit',
          },
        },
        // Rule 2: Geographic restrictions (whitelist approach)
        {
          name: 'GeoWhitelist',
          priority: 2,
          action: { 
            block: {
              customResponse: {
                responseCode: 403,
                customResponseBodyKey: 'GeoBlocked',
              },
            },
          },
          statement: {
            notStatement: {
              statement: {
                geoMatchStatement: {
                  countryCodes: [
                    'AU', 'NZ', // Primary markets
                    'US', 'GB', 'CA', 'IE', // English-speaking
                    'SG', 'MY', 'IN', 'TH', 'PH', // APAC
                    'JP', 'HK', 'ID', 'VN', // Extended APAC
                    'AE', 'SA', 'QA', // Middle East expansion
                    'BR', 'MX', // Americas expansion
                    'DE', 'FR', 'NL', 'CH', 'SE', // Europe
                  ],
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'GeoWhitelist',
          },
        },
        // Rule 3: AWS Managed Core Rule Set
        {
          name: 'CoreRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'SizeRestrictions_BODY' }, // API responses can be large
                { name: 'GenericRFI_BODY' }, // False positives with JSON
              ],
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    byteMatchStatement: {
                      fieldToMatch: { uriPath: {} },
                      textTransformations: [{ priority: 0, type: 'NONE' }],
                      positionalConstraint: 'STARTS_WITH',
                      searchString: '/dashboard',
                    },
                  },
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CoreRuleSet',
          },
        },
        // Rule 4: SQL Injection Protection
        {
          name: 'SQLiProtection',
          priority: 4,
          action: { 
            block: {
              customResponse: {
                responseCode: 403,
                customResponseBodyKey: 'SQLiBlocked',
              },
            },
          },
          statement: {
            orStatement: {
              statements: [
                {
                  sqliMatchStatement: {
                    fieldToMatch: { queryString: {} },
                    textTransformations: [
                      { priority: 0, type: 'URL_DECODE' },
                      { priority: 1, type: 'HTML_ENTITY_DECODE' },
                    ],
                  },
                },
                {
                  sqliMatchStatement: {
                    fieldToMatch: { body: {} },
                    textTransformations: [
                      { priority: 0, type: 'URL_DECODE' },
                      { priority: 1, type: 'HTML_ENTITY_DECODE' },
                    ],
                  },
                },
                {
                  sqliMatchStatement: {
                    fieldToMatch: { allQueryArguments: {} },
                    textTransformations: [
                      { priority: 0, type: 'URL_DECODE' },
                      { priority: 1, type: 'HTML_ENTITY_DECODE' },
                    ],
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'SQLiProtection',
          },
        },
        // Rule 5: API Key Format Validation
        {
          name: 'APIKeyValidation',
          priority: 5,
          action: { 
            block: {
              customResponse: {
                responseCode: 401,
                customResponseBodyKey: 'InvalidAPIKey',
              },
            },
          },
          statement: {
            andStatement: {
              statements: [
                // Check if this is an API endpoint requiring key
                {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                    positionalConstraint: 'STARTS_WITH',
                    searchString: '/api/v1/tax-dates',
                  },
                },
                // Validate API key format if present
                {
                  notStatement: {
                    statement: {
                      regexMatchStatement: {
                        fieldToMatch: {
                          singleHeader: { name: 'x-api-key' },
                        },
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                        regexString: '^gc_live_[a-zA-Z0-9]{32}$',
                      },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'APIKeyValidation',
          },
        },
        // Rule 6: Known Bad Inputs
        {
          name: 'KnownBadInputs',
          priority: 6,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputs',
          },
        },
        // Rule 7: Anonymous IP List
        {
          name: 'AnonymousIPList',
          priority: 7,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAnonymousIPList',
              excludedRules: [
                { name: 'HostingProviderIPList' }, // Allow legitimate hosting providers
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AnonymousIPList',
          },
        },
        // Rule 8: Query Parameter Validation
        {
          name: 'QueryParamValidation',
          priority: 8,
          action: { 
            block: {
              customResponse: {
                responseCode: 400,
                customResponseBodyKey: 'InvalidParameters',
              },
            },
          },
          statement: {
            orStatement: {
              statements: [
                // Validate year parameter (2020-2030)
                {
                  andStatement: {
                    statements: [
                      {
                        byteMatchStatement: {
                          fieldToMatch: {
                            singleQueryArgument: { name: 'year' },
                          },
                          textTransformations: [{ priority: 0, type: 'NONE' }],
                          positionalConstraint: 'EXACTLY',
                          searchString: '',
                        },
                      },
                      {
                        notStatement: {
                          statement: {
                            regexMatchStatement: {
                              fieldToMatch: {
                                singleQueryArgument: { name: 'year' },
                              },
                              textTransformations: [{ priority: 0, type: 'NONE' }],
                              regexString: '^(202[0-9]|2030)$',
                            },
                          },
                        },
                      },
                    ],
                  },
                },
                // Validate country parameter (AU or NZ only)
                {
                  andStatement: {
                    statements: [
                      {
                        byteMatchStatement: {
                          fieldToMatch: {
                            singleQueryArgument: { name: 'country' },
                          },
                          textTransformations: [{ priority: 0, type: 'NONE' }],
                          positionalConstraint: 'EXACTLY',
                          searchString: '',
                        },
                      },
                      {
                        notStatement: {
                          statement: {
                            regexMatchStatement: {
                              fieldToMatch: {
                                singleQueryArgument: { name: 'country' },
                              },
                              textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                              regexString: '^(au|nz)$',
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'QueryParamValidation',
          },
        },
        // Rule 9: Size Restrictions
        {
          name: 'SizeRestrictions',
          priority: 9,
          action: { block: {} },
          statement: {
            orStatement: {
              statements: [
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { uriPath: {} },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                    comparisonOperator: 'GT',
                    size: 2048,
                  },
                },
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { queryString: {} },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                    comparisonOperator: 'GT',
                    size: 4096,
                  },
                },
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { body: {} },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                    comparisonOperator: 'GT',
                    size: 10240, // 10KB max body
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'SizeRestrictions',
          },
        },
        // Rule 10: Advanced API Endpoint Rate Limiting
        {
          name: 'APIEndpointRateLimit',
          priority: 10,
          action: { 
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: 'APIRateLimitExceeded',
              },
            },
          },
          statement: {
            rateBasedStatement: {
              limit: 100, // 100 requests per 5 minutes per IP
              aggregateKeyType: 'IP', // Custom keys are not supported in CloudFormation
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/api/v1/',
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'APIEndpointRateLimit',
          },
        },
      ],
      customResponseBodies: {
        RateLimitExceeded: {
          contentType: 'APPLICATION_JSON',
          content: '{"error":"Rate limit exceeded. Please try again later.","code":"RATE_LIMIT_EXCEEDED"}',
        },
        GeoBlocked: {
          contentType: 'APPLICATION_JSON',
          content: '{"error":"Access denied from your location.","code":"GEO_BLOCKED"}',
        },
        SQLiBlocked: {
          contentType: 'APPLICATION_JSON',
          content: '{"error":"Invalid request detected.","code":"INVALID_REQUEST"}',
        },
        InvalidAPIKey: {
          contentType: 'APPLICATION_JSON',
          content: '{"error":"Invalid API key format.","code":"INVALID_API_KEY"}',
        },
        InvalidParameters: {
          contentType: 'APPLICATION_JSON',
          content: '{"error":"Invalid query parameters.","code":"INVALID_PARAMETERS"}',
        },
        APIRateLimitExceeded: {
          contentType: 'APPLICATION_JSON',
          content: '{"error":"API rate limit exceeded for your key.","code":"API_RATE_LIMIT_EXCEEDED"}',
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'GetComplicalWebAcl',
      },
    });

    // Enable logging for the Web ACL
    const webAclLogging = new wafv2.CfnLoggingConfiguration(this, 'WebAclLogging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [deliveryStream.attrArn],
      redactedFields: [
        {
          singleHeader: { 
            Name: 'x-api-key'  // Capital 'N' for Name
          },
        },
        {
          singleHeader: { 
            Name: 'authorization'  // Capital 'N' for Name
          },
        },
        {
          singleHeader: { 
            Name: 'cookie'  // Capital 'N' for Name
          },
        },
      ],
    });

    // Ensure logging is created after WebACL
    webAclLogging.addDependency(this.webAcl);

    // Store outputs for cross-stack reference
    this.webAclId = this.webAcl.attrId;
    this.webAclArn = this.webAcl.attrArn;

    // CloudWatch Alarms for WAF monitoring
    const blockedRequestsAlarm = new cloudwatch.Alarm(this, 'WAFBlockedRequestsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          Rule: 'ALL',
          WebACL: this.webAcl.name!,
          Region: 'Global',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 100,
      evaluationPeriods: 2,
      alarmDescription: 'Alert when WAF blocks more than 100 requests in 10 minutes',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const rateLimitAlarm = new cloudwatch.Alarm(this, 'WAFRateLimitAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          Rule: 'IPRateLimit',
          WebACL: this.webAcl.name!,
          Region: 'Global',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 50,
      evaluationPeriods: 1,
      alarmDescription: 'Alert when rate limiting blocks more than 50 requests in 5 minutes',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebAclId', {
      value: this.webAclId,
      description: 'WAF Web ACL ID',
      exportName: 'GetComplicalWebAclId',
    });

    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAclArn,
      description: 'WAF Web ACL ARN',
      exportName: 'GetComplicalWebAclArn',
    });

    new cdk.CfnOutput(this, 'WafLogsBucketName', {
      value: wafLogsBucket.bucketName,
      description: 'S3 bucket for WAF logs',
    });

    new cdk.CfnOutput(this, 'FirehoseStreamName', {
      value: deliveryStream.ref,
      description: 'Kinesis Firehose delivery stream name',
    });

    new cdk.CfnOutput(this, 'BlockedRequestsAlarmName', {
      value: blockedRequestsAlarm.alarmName,
      description: 'CloudWatch alarm for blocked requests',
    });
  }
}