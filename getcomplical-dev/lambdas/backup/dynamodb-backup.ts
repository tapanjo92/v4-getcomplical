import { ScheduledHandler } from 'aws-lambda';
import { DynamoDBClient, ScanCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const cloudwatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

interface BackupResult {
  tableName: string;
  itemCount: number;
  backupSize: number;
  success: boolean;
  error?: string;
  s3Key?: string;
}

async function backupTable(tableName: string, bucketName: string): Promise<BackupResult> {
  const startTime = Date.now();
  const result: BackupResult = {
    tableName,
    itemCount: 0,
    backupSize: 0,
    success: false
  };
  
  try {
    // Check table exists and get metadata
    const describeCommand = new DescribeTableCommand({ TableName: tableName });
    const tableInfo = await dynamoClient.send(describeCommand);
    
    if (tableInfo.Table?.TableStatus !== 'ACTIVE') {
      throw new Error(`Table ${tableName} is not active`);
    }
    
    // Scan all items from table
    const items: any[] = [];
    let lastEvaluatedKey: any = undefined;
    
    do {
      const scanCommand = new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey,
        ConsistentRead: true
      });
      
      const response = await dynamoClient.send(scanCommand);
      
      if (response.Items) {
        items.push(...response.Items);
        result.itemCount += response.Items.length;
      }
      
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    
    // Create backup JSON
    const backup = {
      tableName,
      backupTimestamp: new Date().toISOString(),
      tableArn: tableInfo.Table?.TableArn,
      itemCount: result.itemCount,
      items: items
    };
    
    const backupJson = JSON.stringify(backup, null, 2);
    result.backupSize = Buffer.byteLength(backupJson);
    
    // Generate S3 key with date partitioning
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
    
    result.s3Key = `dynamodb-backups/${tableName}/${year}/${month}/${day}/${tableName}-${timestamp}.json`;
    
    // Upload to S3
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: result.s3Key,
      Body: backupJson,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      Metadata: {
        'table-name': tableName,
        'item-count': String(result.itemCount),
        'backup-date': date.toISOString()
      }
    });
    
    await s3Client.send(putCommand);
    result.success = true;
    
    console.log(`Successfully backed up ${tableName}: ${result.itemCount} items, ${result.backupSize} bytes`);
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to backup ${tableName}:`, error);
  }
  
  // Send metrics to CloudWatch
  const metrics = new PutMetricDataCommand({
    Namespace: 'GetComplical/Backup',
    MetricData: [
      {
        MetricName: 'BackupSuccess',
        Value: result.success ? 1 : 0,
        Unit: 'Count',
        Dimensions: [{ Name: 'TableName', Value: tableName }],
        Timestamp: new Date()
      },
      {
        MetricName: 'BackupItemCount',
        Value: result.itemCount,
        Unit: 'Count',
        Dimensions: [{ Name: 'TableName', Value: tableName }],
        Timestamp: new Date()
      },
      {
        MetricName: 'BackupSizeBytes',
        Value: result.backupSize,
        Unit: 'Bytes',
        Dimensions: [{ Name: 'TableName', Value: tableName }],
        Timestamp: new Date()
      },
      {
        MetricName: 'BackupDurationMs',
        Value: Date.now() - startTime,
        Unit: 'Milliseconds',
        Dimensions: [{ Name: 'TableName', Value: tableName }],
        Timestamp: new Date()
      }
    ]
  });
  
  await cloudwatchClient.send(metrics);
  
  return result;
}

export const handler: ScheduledHandler = async (event) => {
  console.log('Starting DynamoDB backup process', { event });
  
  const bucketName = process.env.BACKUP_BUCKET_NAME;
  const tablesToBackup = [
    process.env.API_KEYS_TABLE || 'getcomplical-api-keys',
    process.env.TAX_DATA_TABLE || 'getcomplical-tax-data',
    // Note: Not backing up rate limit table as it has TTL and is transient data
  ];
  
  if (!bucketName) {
    throw new Error('BACKUP_BUCKET_NAME environment variable not set');
  }
  
  const results: BackupResult[] = [];
  
  // Backup tables in parallel
  const backupPromises = tablesToBackup.map(table => backupTable(table, bucketName));
  const backupResults = await Promise.allSettled(backupPromises);
  
  backupResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      results.push({
        tableName: tablesToBackup[index],
        itemCount: 0,
        backupSize: 0,
        success: false,
        error: result.reason?.message || 'Unknown error'
      });
    }
  });
  
  // Generate summary
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;
  const totalItems = results.reduce((sum, r) => sum + r.itemCount, 0);
  const totalSize = results.reduce((sum, r) => sum + r.backupSize, 0);
  
  const summary = {
    timestamp: new Date().toISOString(),
    successCount,
    failureCount,
    totalItems,
    totalSize,
    results
  };
  
  console.log('Backup process completed', summary);
  
  // Send SNS notification if any failures
  if (failureCount > 0 && process.env.SNS_TOPIC_ARN) {
    const message = `DynamoDB Backup Alert: ${failureCount} table(s) failed to backup

Summary:
- Success: ${successCount} tables
- Failed: ${failureCount} tables
- Total items backed up: ${totalItems}
- Total backup size: ${(totalSize / 1024 / 1024).toFixed(2)} MB

Failed tables:
${results.filter(r => !r.success).map(r => `- ${r.tableName}: ${r.error}`).join('\n')}

Please check CloudWatch logs for details.`;
    
    await snsClient.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: `[GetComplical] DynamoDB Backup Failure - ${failureCount} tables`,
      Message: message
    }));
  }
  
  // Return summary
  return {
    statusCode: successCount === tablesToBackup.length ? 200 : 500,
    body: JSON.stringify(summary, null, 2)
  };
};