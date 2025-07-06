import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import * as path from 'path';

interface BackupStackProps extends cdk.StackProps {
  apiKeysTable: dynamodb.Table;
  taxDataTable: dynamodb.Table;
  userPool: cognito.UserPool;
}

export class BackupStack extends cdk.Stack {
  public readonly backupBucket: s3.Bucket;
  public readonly backupFunction: NodejsFunction;
  public readonly restoreFunction: NodejsFunction;
  public readonly alertTopic: sns.Topic;
  
  constructor(scope: Construct, id: string, props: BackupStackProps) {
    super(scope, id, props);
    
    // Create S3 bucket for backups
    this.backupBucket = new s3.Bucket(this, 'BackupBucket', {
      bucketName: `getcomplical-backups-${this.account}-${this.region}`,
      versioned: true,
      lifecycleRules: [{
        id: 'DeleteOldBackups',
        expiration: cdk.Duration.days(90),
        transitions: [{
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(30),
        }],
      }, {
        id: 'CleanupIncompleteMultipartUploads',
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Never delete backup bucket
    });
    
    // Create SNS topic for alerts
    this.alertTopic = new sns.Topic(this, 'BackupAlertTopic', {
      topicName: 'getcomplical-backup-alerts',
      displayName: 'GetComplical Backup Alerts',
    });
    
    // Add email subscription if email is provided
    const alertEmail = this.node.tryGetContext('alertEmail');
    if (alertEmail) {
      this.alertTopic.addSubscription(
        new subscriptions.EmailSubscription(alertEmail)
      );
    }
    
    // Create backup Lambda function
    this.backupFunction = new NodejsFunction(this, 'BackupFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/backup/dynamodb-backup.ts'),
      handler: 'handler',
      environment: {
        BACKUP_BUCKET_NAME: this.backupBucket.bucketName,
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        TAX_DATA_TABLE: props.taxDataTable.tableName,
        SNS_TOPIC_ARN: this.alertTopic.topicArn,
      },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });
    
    // Create restore Lambda function
    this.restoreFunction = new NodejsFunction(this, 'RestoreFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lambdas/backup/dynamodb-restore.ts'),
      handler: 'handler',
      environment: {
        BACKUP_BUCKET_NAME: this.backupBucket.bucketName,
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        TAX_DATA_TABLE: props.taxDataTable.tableName,
      },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        target: 'node20',
        sourceMap: true,
      },
    });
    
    // Grant permissions
    this.backupBucket.grantReadWrite(this.backupFunction);
    this.backupBucket.grantRead(this.restoreFunction);
    
    props.apiKeysTable.grantReadData(this.backupFunction);
    props.taxDataTable.grantReadData(this.backupFunction);
    
    props.apiKeysTable.grantWriteData(this.restoreFunction);
    props.taxDataTable.grantWriteData(this.restoreFunction);
    
    this.alertTopic.grantPublish(this.backupFunction);
    
    // Grant CloudWatch metrics permissions
    const metricsPolicy = new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'GetComplical/Backup'
        }
      }
    });
    
    this.backupFunction.addToRolePolicy(metricsPolicy);
    
    // Create scheduled backup rule - daily at 2 AM UTC
    const backupRule = new events.Rule(this, 'BackupScheduleRule', {
      ruleName: 'getcomplical-daily-backup',
      description: 'Trigger daily DynamoDB backup at 2 AM UTC',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '2',
        day: '*',
        month: '*',
        year: '*',
      }),
    });
    
    backupRule.addTarget(new targets.LambdaFunction(this.backupFunction, {
      retryAttempts: 2,
    }));
    
    // Create API endpoint for restore (admin only)
    const restoreApi = new apigateway.LambdaRestApi(this, 'RestoreApi', {
      handler: this.restoreFunction,
      restApiName: 'GetComplical Restore API',
      description: 'Admin API for restoring DynamoDB tables from backup',
      proxy: false,
      deployOptions: {
        stageName: 'v1',
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });
    
    // Cognito authorizer for restore endpoint
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'RestoreAuthorizer', {
      cognitoUserPools: [props.userPool],
      identitySource: 'method.request.header.Authorization',
    });
    
    const restoreResource = restoreApi.root.addResource('restore');
    restoreResource.addMethod('POST', undefined, {
      authorizer: cognitoAuthorizer,
      requestValidatorOptions: {
        requestValidatorName: 'ValidateBody',
        validateRequestBody: true,
      },
    });
    
    // Outputs
    new cdk.CfnOutput(this, 'BackupBucketName', {
      value: this.backupBucket.bucketName,
      description: 'S3 bucket for DynamoDB backups',
    });
    
    new cdk.CfnOutput(this, 'BackupFunctionArn', {
      value: this.backupFunction.functionArn,
      description: 'ARN of the backup Lambda function',
    });
    
    new cdk.CfnOutput(this, 'RestoreApiUrl', {
      value: restoreApi.url,
      description: 'URL for the restore API',
    });
    
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic for backup alerts',
    });
  }
}