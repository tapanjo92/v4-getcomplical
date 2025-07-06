import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class StorageStack extends cdk.Stack {
  public readonly apiKeysTable: dynamodb.Table;
  public readonly taxDataTable: dynamodb.Table;
  public readonly rateLimitTable: dynamodb.Table;
  public readonly usageMetricsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.apiKeysTable = new dynamodb.Table(this, 'ApiKeysTable', {
      tableName: 'getcomplical-api-keys',
      partitionKey: {
        name: 'apiKey',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.apiKeysTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Add status-createdAt index for usage aggregation
    this.apiKeysTable.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.taxDataTable = new dynamodb.Table(this, 'TaxDataTable', {
      tableName: 'getcomplical-tax-data',
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.taxDataTable.addGlobalSecondaryIndex({
      indexName: 'type-date-index',
      partitionKey: {
        name: 'type',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'date',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // New table for sharded rate limiting with rolling windows
    this.rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName: 'getcomplical-rate-limits',
      partitionKey: {
        name: 'pk', // Format: apiKey#shard#0-9
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'ApiKeysTableName', {
      value: this.apiKeysTable.tableName,
      description: 'Name of the API Keys DynamoDB table',
    });

    new cdk.CfnOutput(this, 'TaxDataTableName', {
      value: this.taxDataTable.tableName,
      description: 'Name of the Tax Data DynamoDB table',
    });

    new cdk.CfnOutput(this, 'RateLimitTableName', {
      value: this.rateLimitTable.tableName,
      description: 'Name of the Rate Limit DynamoDB table',
    });
    
    // Usage metrics table for detailed tracking and billing
    this.usageMetricsTable = new dynamodb.Table(this, 'UsageMetricsTable', {
      tableName: 'getcomplical-usage-metrics',
      partitionKey: {
        name: 'pk', // Format: usage#apiKey or usage#customerId
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk', // Format: YYYY-MM#type#YYYY-MM-DD (e.g., 2025-01#daily#2025-01-15)
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    
    // GSI for querying by customer ID
    this.usageMetricsTable.addGlobalSecondaryIndex({
      indexName: 'customerId-date-index',
      partitionKey: {
        name: 'customerId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'date',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    
    // GSI for querying by date across all customers
    this.usageMetricsTable.addGlobalSecondaryIndex({
      indexName: 'date-apiKey-index',
      partitionKey: {
        name: 'date',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'apiKey',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    
    new cdk.CfnOutput(this, 'UsageMetricsTableName', {
      value: this.usageMetricsTable.tableName,
      description: 'Name of the Usage Metrics DynamoDB table',
    });
  }
}