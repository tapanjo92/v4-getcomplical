import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as kinesis from 'aws-cdk-lib/aws-kinesisfirehose';
import * as kinesisanalytics from 'aws-cdk-lib/aws-kinesisanalyticsv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class StreamingStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly redisCluster: elasticache.CfnReplicationGroup;
  public readonly redisEndpoint: string;
  public readonly firehoseStream: kinesis.CfnDeliveryStream;
  public readonly analyticsBucket: s3.Bucket;
  public readonly firehoseRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    // Use a STABLE suffix for resources - this prevents creating new resources on every deployment
    // CRITICAL: This must be stable across deployments to avoid resource churn
    const uniqueSuffix = 'prod-v2'; // Fixed suffix for production stability

    // Create VPC for Redis (ElastiCache requires VPC)
    this.vpc = new ec2.Vpc(this, 'StreamingVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Create subnet group for ElastiCache
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      cacheSubnetGroupName: `gc-valkey-subnet-${uniqueSuffix}`.substring(0, 255),
      description: 'Subnet group for Valkey cluster',
      subnetIds: this.vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    // Create security group for Valkey
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Valkey cluster',
      allowAllOutbound: true,
    });

    // Allow Valkey port from Lambda functions
    redisSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Allow Valkey access from VPC'
    );

    // Create Valkey replication group for sub-millisecond rate limiting
    // Valkey is the open-source Redis alternative backed by AWS, Linux Foundation
    this.redisCluster = new elasticache.CfnReplicationGroup(this, 'RateLimitValkey', {
      replicationGroupId: `gc-valkey-${uniqueSuffix}`.substring(0, 40),  // ElastiCache has 40 char limit
      replicationGroupDescription: 'Valkey cluster for GetComplical rate limiting',
      engine: 'valkey',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: 1,  // Single node for development
      port: 6379,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [redisSecurityGroup.securityGroupId],
      engineVersion: '7.2',
      automaticFailoverEnabled: false,  // Single node doesn't need failover
      transitEncryptionEnabled: false,  // Required parameter for Valkey
      preferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      snapshotRetentionLimit: 1,
      snapshotWindow: '03:00-04:00',
      tags: [
        { key: 'Environment', value: 'production' },
        { key: 'Service', value: 'getcomplical' },
        { key: 'Engine', value: 'valkey' },
      ],
    });

    // Create S3 bucket for analytics data
    this.analyticsBucket = new s3.Bucket(this, 'AnalyticsBucket', {
      bucketName: `gc-analytics-${uniqueSuffix}-${this.account}-${this.region}`,
      lifecycleRules: [
        {
          id: 'archive-old-data',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
    });

    // Create IAM role for Kinesis Firehose
    this.firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      description: 'Role for Kinesis Firehose to write to S3',
    });

    // Grant Firehose permissions to S3
    this.analyticsBucket.grantReadWrite(this.firehoseRole);

    // Create log group and stream for Firehose errors
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: `/aws/kinesisfirehose/gc-usage-${uniqueSuffix}`,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const firehoseLogStream = new logs.LogStream(this, 'FirehoseLogStream', {
      logGroup: firehoseLogGroup,
      logStreamName: 'S3Delivery',
    });

    // Grant Firehose permissions to CloudWatch Logs
    firehoseLogGroup.grantWrite(this.firehoseRole);

    // Create Kinesis Data Firehose for event streaming
    this.firehoseStream = new kinesis.CfnDeliveryStream(this, 'UsageFirehose', {
      deliveryStreamName: `gc-usage-events-${uniqueSuffix}`,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: this.analyticsBucket.bucketArn,
        prefix: 'usage-events/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'error-events/',
        compressionFormat: 'UNCOMPRESSED', // Required when using data format conversion
        roleArn: this.firehoseRole.roleArn,
        bufferingHints: {
          intervalInSeconds: 300, // Buffer for 5 minutes (better for Parquet)
          sizeInMBs: 128, // 128MB - minimum is 64MB for Parquet, but 128MB is more efficient
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
        },
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: {
            deserializer: {
              openXJsonSerDe: {
                caseInsensitive: true,
                columnToJsonKeyMappings: {},
                convertDotsInJsonKeysToUnderscores: false,
              },
            },
          },
          outputFormatConfiguration: {
            serializer: {
              parquetSerDe: {
                compression: 'SNAPPY', // Best compression for Parquet
              },
            },
          },
          schemaConfiguration: {
            databaseName: 'getcomplical_analytics',
            tableName: 'usage_events',
            roleArn: this.firehoseRole.roleArn,
          },
        },
        processingConfiguration: {
          enabled: false,  // Disable processing - RecordDeAggregation requires Dynamic Partitioning
        },
      },
    });

    // Create Glue Database for Athena queries
    const glueDatabase = new glue.CfnDatabase(this, 'AnalyticsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'getcomplical_analytics',
        description: 'Database for GetComplical usage analytics',
      },
    });

    // Create Glue Table for usage events
    const glueTable = new glue.CfnTable(this, 'UsageEventsTable', {
      catalogId: this.account,
      databaseName: 'getcomplical_analytics',
      tableInput: {
        name: 'usage_events',
        description: 'API usage events from Kinesis Firehose',
        storageDescriptor: {
          columns: [
            { name: 'timestamp', type: 'string' }, // ISO 8601 string
            { name: 'request_id', type: 'string' },
            { name: 'api_key', type: 'string' },
            { name: 'customer_id', type: 'string' },
            { name: 'user_id', type: 'string' },
            { name: 'tier', type: 'string' },
            { name: 'endpoint', type: 'string' },
            { name: 'method', type: 'string' },
            { name: 'status_code', type: 'bigint' }, // Parquet prefers bigint
            { name: 'response_time_ms', type: 'bigint' },
            { name: 'region', type: 'string' },
            { name: 'cache_hit', type: 'boolean' },
            { name: 'rate_limit_exceeded', type: 'boolean' },
            { name: 'error_message', type: 'string' },
          ],
          location: `s3://${this.analyticsBucket.bucketName}/usage-events/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        tableType: 'EXTERNAL_TABLE',
      },
    });

    // Grant comprehensive Glue permissions to Firehose role
    // Critical: Kinesis Firehose with Parquet conversion requires specific Glue permissions
    // Based on 30+ years experience: AWS Glue requires certain permissions at the account level
    
    // First, add the managed policy for Glue service role (recommended by AWS)
    this.firehoseRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')
    );
    
    // Additional specific permissions for Firehose data format conversion
    this.firehoseRole.addToPolicy(new iam.PolicyStatement({
      sid: 'GlueTableAccess',
      actions: [
        'glue:GetDatabase',
        'glue:GetDatabases', 
        'glue:GetTable',
        'glue:GetTables',
        'glue:GetTableVersion',
        'glue:GetTableVersions',
        'glue:GetPartition',
        'glue:GetPartitions',
        'glue:BatchGetPartition',
        'glue:GetSchema',
        'glue:GetSchemaVersion',
        'glue:GetRegistry',
        'glue:ListRegistries',
        'glue:ListSchemas',
        'glue:ListSchemaVersions',
      ],
      resources: ['*'],  // Required by AWS - these actions don't support resource-level permissions
      conditions: {
        StringEquals: {
          'aws:RequestedRegion': this.region,
        },
      },
    }));

    // Ensure Glue resources are created before Firehose
    this.firehoseStream.node.addDependency(glueDatabase);
    this.firehoseStream.node.addDependency(glueTable);

    // Output Redis endpoint - use PrimaryEndPoint for replication groups
    this.redisEndpoint = cdk.Fn.getAtt(this.redisCluster.logicalId, 'PrimaryEndPoint.Address').toString();

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.redisEndpoint,
      description: 'Valkey cluster endpoint for rate limiting',
      exportName: `${this.stackName}:RedisEndpoint`,
    });

    new cdk.CfnOutput(this, 'FirehoseStreamName', {
      value: this.firehoseStream.ref,
      description: 'Kinesis Firehose stream name',
    });

    new cdk.CfnOutput(this, 'AnalyticsBucketName', {
      value: this.analyticsBucket.bucketName,
      description: 'S3 bucket for analytics data',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID for Lambda functions',
    });
  }
}