import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

interface RestoreRequest {
  tableName: string;
  backupDate?: string; // Optional: specific date YYYY-MM-DD
  s3Key?: string; // Optional: specific backup file
  dryRun?: boolean; // Optional: validate without restoring
}

interface BackupData {
  tableName: string;
  backupTimestamp: string;
  tableArn: string;
  itemCount: number;
  items: any[];
}

async function findLatestBackup(bucketName: string, tableName: string, backupDate?: string): Promise<string | null> {
  const prefix = backupDate 
    ? `dynamodb-backups/${tableName}/${backupDate.replace(/-/g, '/')}/`
    : `dynamodb-backups/${tableName}/`;
  
  const listCommand = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
    MaxKeys: 1000
  });
  
  const response = await s3Client.send(listCommand);
  
  if (!response.Contents || response.Contents.length === 0) {
    return null;
  }
  
  // Sort by LastModified descending to get latest
  const sortedObjects = response.Contents
    .filter(obj => obj.Key?.endsWith('.json'))
    .sort((a, b) => {
      const timeA = a.LastModified?.getTime() || 0;
      const timeB = b.LastModified?.getTime() || 0;
      return timeB - timeA;
    });
  
  return sortedObjects[0]?.Key || null;
}

async function restoreTable(bucketName: string, s3Key: string, dryRun: boolean = false): Promise<any> {
  // Download backup from S3
  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: s3Key
  });
  
  const response = await s3Client.send(getCommand);
  const backupJson = await response.Body?.transformToString();
  
  if (!backupJson) {
    throw new Error('Failed to read backup file');
  }
  
  const backupData: BackupData = JSON.parse(backupJson);
  
  console.log(`Found backup for ${backupData.tableName} with ${backupData.itemCount} items from ${backupData.backupTimestamp}`);
  
  if (dryRun) {
    return {
      message: 'Dry run successful',
      tableName: backupData.tableName,
      itemCount: backupData.itemCount,
      backupTimestamp: backupData.backupTimestamp,
      wouldRestore: true
    };
  }
  
  // Restore items in batches of 25 (DynamoDB limit)
  const batchSize = 25;
  let restoredCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < backupData.items.length; i += batchSize) {
    const batch = backupData.items.slice(i, i + batchSize);
    
    try {
      const batchCommand = new BatchWriteItemCommand({
        RequestItems: {
          [backupData.tableName]: batch.map(item => ({
            PutRequest: { Item: item }
          }))
        }
      });
      
      const batchResponse = await dynamoClient.send(batchCommand);
      
      // Handle unprocessed items
      if (batchResponse.UnprocessedItems && 
          batchResponse.UnprocessedItems[backupData.tableName]?.length > 0) {
        const unprocessedCount = batchResponse.UnprocessedItems[backupData.tableName].length;
        console.warn(`${unprocessedCount} items were not processed in batch`);
        errorCount += unprocessedCount;
        restoredCount += (batch.length - unprocessedCount);
      } else {
        restoredCount += batch.length;
      }
      
      // Progress logging
      if ((i + batch.length) % 100 === 0 || (i + batch.length) >= backupData.items.length) {
        console.log(`Progress: ${i + batch.length}/${backupData.items.length} items processed`);
      }
      
    } catch (error) {
      console.error(`Error processing batch starting at index ${i}:`, error);
      errorCount += batch.length;
    }
  }
  
  return {
    tableName: backupData.tableName,
    backupTimestamp: backupData.backupTimestamp,
    totalItems: backupData.itemCount,
    restoredItems: restoredCount,
    failedItems: errorCount,
    success: errorCount === 0
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Check authorization - this should only be accessible to admins
  const authHeader = event.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }
  
  const bucketName = process.env.BACKUP_BUCKET_NAME;
  if (!bucketName) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Backup bucket not configured' })
    };
  }
  
  try {
    const body: RestoreRequest = JSON.parse(event.body || '{}');
    
    if (!body.tableName) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'tableName is required' })
      };
    }
    
    // Validate table name
    const allowedTables = [
      process.env.API_KEYS_TABLE || 'getcomplical-api-keys',
      process.env.TAX_DATA_TABLE || 'getcomplical-tax-data'
    ];
    
    if (!allowedTables.includes(body.tableName)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Invalid table name',
          allowedTables
        })
      };
    }
    
    // Find the backup to restore
    let s3Key = body.s3Key;
    
    if (!s3Key) {
      s3Key = await findLatestBackup(bucketName, body.tableName, body.backupDate) || undefined;
      
      if (!s3Key) {
        return {
          statusCode: 404,
          body: JSON.stringify({ 
            error: 'No backup found',
            tableName: body.tableName,
            backupDate: body.backupDate
          })
        };
      }
    }
    
    console.log(`Restoring from backup: ${s3Key}`);
    
    // Perform restore
    const result = await restoreTable(bucketName, s3Key, body.dryRun || false);
    
    return {
      statusCode: result.success ? 200 : 207, // 207 for partial success
      body: JSON.stringify({
        message: body.dryRun ? 'Dry run completed' : 'Restore completed',
        ...result,
        s3Key
      }, null, 2)
    };
    
  } catch (error) {
    console.error('Restore error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Restore failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};