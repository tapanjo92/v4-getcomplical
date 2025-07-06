import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kinesisfirehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
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

    // Create S3 bucket for WAF logs
    const wafLogsBucket = new s3.Bucket(this, 'WafLogsBucket', {
      bucketName: `getcomplical-waf-logs-${this.account}-${this.region}`,
      lifecycleRules: [{
        id: 'DeleteOldLogs',
        expiration: cdk.Duration.days(90),
        transitions: [{
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: cdk.Duration.days(30),
        }],
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Create IAM role for Kinesis Firehose
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });

    wafLogsBucket.grantWrite(firehoseRole);

    // Create CloudWatch log group for Firehose errors
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: '/aws/kinesisfirehose/getcomplical-waf',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    firehoseLogGroup.grantWrite(firehoseRole);

    // Create Kinesis Firehose delivery stream
    const deliveryStream = new kinesisfirehose.CfnDeliveryStream(this, 'WafLogsDeliveryStream', {
      deliveryStreamName: 'aws-waf-logs-getcomplical',
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: wafLogsBucket.bucketArn,
        prefix: 'waf-logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'waf-logs-errors/',
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'GZIP',
        bufferingHints: {
          intervalInSeconds: 300,
          sizeInMBs: 5,
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: 'S3Delivery',
        },
      },
    });

    // Create the Web ACL with simplified rules
    this.webAcl = new wafv2.CfnWebACL(this, 'GetComplicalWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      name: 'GetComplicalAPIProtection',
      description: 'WAF protection for GetComplical Tax API',
      rules: [
        // Rule 1: Rate limiting per IP
        {
          name: 'IPRateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'IPRateLimit',
          },
        },
        // Rule 2: AWS Managed Core Rule Set
        {
          name: 'CoreRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'SizeRestrictions_BODY' },
                { name: 'GenericRFI_BODY' },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CoreRuleSet',
          },
        },
        // Rule 3: Known Bad Inputs
        {
          name: 'KnownBadInputs',
          priority: 3,
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
        // Rule 4: SQL Injection Protection
        {
          name: 'SQLiProtection',
          priority: 4,
          action: { block: {} },
          statement: {
            sqliMatchStatement: {
              fieldToMatch: { queryString: {} },
              textTransformations: [
                { priority: 0, type: 'URL_DECODE' },
                { priority: 1, type: 'HTML_ENTITY_DECODE' },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'SQLiProtection',
          },
        },
        // Rule 5: Size Restrictions
        {
          name: 'SizeRestrictions',
          priority: 5,
          action: { block: {} },
          statement: {
            orStatement: {
              statements: [
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { queryString: {} },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                    comparisonOperator: 'GT',
                    size: 2048,
                  },
                },
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { body: {} },
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                    comparisonOperator: 'GT',
                    size: 10240,
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
        // Rule 6: Geographic Restrictions
        {
          name: 'GeoBlocking',
          priority: 6,
          action: { block: {} },
          statement: {
            notStatement: {
              statement: {
                geoMatchStatement: {
                  countryCodes: [
                    'AU', 'NZ', // Primary markets
                    'US', 'GB', 'CA', 'IE', // English-speaking
                    'SG', 'MY', 'IN', 'TH', // APAC
                    'JP', 'HK', 'ID', // Extended APAC
                  ],
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'GeoBlocking',
          },
        },
      ],
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
            Name: 'x-api-key'
          },
        },
        {
          singleHeader: { 
            Name: 'authorization'
          },
        },
      ],
    });

    webAclLogging.addDependency(this.webAcl);

    // Store outputs
    this.webAclId = this.webAcl.attrId;
    this.webAclArn = this.webAcl.attrArn;

    // CloudWatch Alarms
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

    new cdk.CfnOutput(this, 'BlockedRequestsAlarmName', {
      value: blockedRequestsAlarm.alarmName,
      description: 'CloudWatch alarm for blocked requests',
    });
  }
}