import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const cloudWatchClient = new CloudWatchClient({ region: process.env.AWS_REGION });

const TAX_DATA_TABLE = process.env.TAX_DATA_TABLE!;

// Cache configuration based on query type
const getCacheHeaders = (hasFilters: boolean, isCacheHit: boolean = false): Record<string, string> => {
  const baseHeaders: Record<string, string> = {
    'Vary': 'X-Api-Key, Accept-Encoding',
    'X-Cache-Status': isCacheHit ? 'HIT' : 'MISS',
  };

  if (hasFilters) {
    // Shorter cache for filtered queries (6 hours)
    return {
      ...baseHeaders,
      'Cache-Control': 'public, max-age=21600, s-maxage=21600, stale-while-revalidate=3600',
      'Surrogate-Control': 'max-age=21600',
      'X-Cache-Strategy': 'filtered-query',
      'CDN-Cache-Control': 'max-age=21600',
    };
  } else {
    // Longer cache for popular queries (24 hours)
    return {
      ...baseHeaders,
      'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=7200',
      'Surrogate-Control': 'max-age=86400',
      'X-Cache-Strategy': 'popular-query',
      'CDN-Cache-Control': 'max-age=86400',
    };
  }
};

// Send metrics to CloudWatch
async function sendMetrics(
  queryType: string,
  responseTime: number,
  itemCount: number,
  cacheStrategy: string,
  statusCode: number
): Promise<void> {
  try {
    const params = {
      Namespace: 'GetComplical/API',
      MetricData: [
        {
          MetricName: 'ResponseTime',
          Value: responseTime,
          Unit: 'Milliseconds',
          Dimensions: [
            { Name: 'QueryType', Value: queryType },
            { Name: 'CacheStrategy', Value: cacheStrategy },
          ],
          Timestamp: new Date(),
        },
        {
          MetricName: 'ItemCount',
          Value: itemCount,
          Unit: 'Count',
          Dimensions: [
            { Name: 'QueryType', Value: queryType },
          ],
          Timestamp: new Date(),
        },
        {
          MetricName: 'RequestCount',
          Value: 1,
          Unit: 'Count',
          Dimensions: [
            { Name: 'QueryType', Value: queryType },
            { Name: 'StatusCode', Value: statusCode.toString() },
          ],
          Timestamp: new Date(),
        },
      ],
    };

    await cloudWatchClient.send(new PutMetricDataCommand(params));
  } catch (error) {
    console.error('Failed to send metrics:', error);
    // Don't throw - metrics failure shouldn't break the API
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  console.log('API event:', JSON.stringify(event, null, 2));

  // Check if this is a CloudFront cache hit (won't reach Lambda)
  const isCacheHit = event.headers['X-Cache-Status'] === 'HIT';

  // Extract rate limit info from authorizer context
  const authContext = event.requestContext.authorizer || {};
  
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // Add rate limit headers
    'X-RateLimit-Limit': authContext.dailyLimit || '1000',
    'X-RateLimit-Remaining': authContext.remainingRequests || '0',
    'X-RateLimit-Reset': authContext.resetsAt || new Date(Date.now() + 86400000).toISOString(),
    'X-RateLimit-Tier': authContext.tier || 'free',
  };

  try {
    const { country, year, type, state, agency, frequency } = event.queryStringParameters || {};

    if (!country || !year) {
      const errorResponse = {
        statusCode: 400,
        headers: {
          ...baseHeaders,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
        body: JSON.stringify({
          error: 'Missing required parameters: country and year',
        }),
      };

      await sendMetrics('invalid', Date.now() - startTime, 0, 'no-cache', 400);
      return errorResponse;
    }

    // Security: Validate year parameter to prevent invalid queries
    const yearNum = parseInt(year, 10);
    if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2030) {
      const errorResponse = {
        statusCode: 400,
        headers: {
          ...baseHeaders,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
        body: JSON.stringify({
          error: 'Year must be between 2020 and 2030',
        }),
      };

      await sendMetrics('invalid', Date.now() - startTime, 0, 'no-cache', 400);
      return errorResponse;
    }

    const countryUpper = country.toUpperCase();
    if (!['AU', 'NZ'].includes(countryUpper)) {
      const errorResponse = {
        statusCode: 400,
        headers: {
          ...baseHeaders,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
        body: JSON.stringify({
          error: 'Country must be AU or NZ',
        }),
      };

      await sendMetrics('invalid', Date.now() - startTime, 0, 'no-cache', 400);
      return errorResponse;
    }

    const pk = `${countryUpper}#${year}`;
    const hasFilters = !!(type || state || agency || frequency);
    
    // Determine query type for metrics
    let queryType = `${countryUpper}-base`;
    if (type) queryType = `${countryUpper}-type-${type}`;
    else if (state) queryType = `${countryUpper}-state-${state}`;
    else if (agency) queryType = `${countryUpper}-agency`;
    else if (frequency) queryType = `${countryUpper}-frequency`;
    
    const queryParams: any = {
      TableName: TAX_DATA_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': pk,
      },
    };

    // Build filter expressions for multiple filters
    const filterExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const additionalAttributeValues: Record<string, any> = {};

    if (type) {
      filterExpressions.push('#type = :type');
      expressionAttributeNames['#type'] = 'type';
      additionalAttributeValues[':type'] = type;
    }

    if (state) {
      filterExpressions.push('contains(#states, :state)');
      expressionAttributeNames['#states'] = 'states';
      additionalAttributeValues[':state'] = state.toUpperCase();
    }

    if (agency) {
      filterExpressions.push('#agency = :agency');
      expressionAttributeNames['#agency'] = 'agency';
      additionalAttributeValues[':agency'] = agency;
    }

    if (frequency) {
      filterExpressions.push('#frequency = :frequency');
      expressionAttributeNames['#frequency'] = 'frequency';
      additionalAttributeValues[':frequency'] = frequency;
    }

    if (filterExpressions.length > 0) {
      queryParams.FilterExpression = filterExpressions.join(' AND ');
      queryParams.ExpressionAttributeNames = expressionAttributeNames;
      queryParams.ExpressionAttributeValues = {
        ...queryParams.ExpressionAttributeValues,
        ...additionalAttributeValues,
      };
    }

    const queryStartTime = Date.now();
    const { Items = [] } = await docClient.send(new QueryCommand(queryParams));
    const queryTime = Date.now() - queryStartTime;

    const taxDates = Items.map(item => ({
      date: item.date,
      name: item.name,
      description: item.description,
      type: item.type,
      agency: item.agency,
      state: item.state,
      frequency: item.frequency,
      threshold: item.threshold,
      isPublicHoliday: item.isPublicHoliday || false,
      isBusinessDay: item.isBusinessDay || true,
    }));

    // Sort by date
    taxDates.sort((a, b) => a.date.localeCompare(b.date));

    // Get appropriate cache headers
    const cacheHeaders = getCacheHeaders(hasFilters, isCacheHit);
    const cacheStrategy = hasFilters ? 'filtered-query' : 'popular-query';

    // Calculate total response time
    const totalResponseTime = Date.now() - startTime;

    // Send metrics asynchronously (don't wait)
    const metricsPromise = sendMetrics(
      queryType,
      totalResponseTime,
      taxDates.length,
      cacheStrategy,
      200
    );

    const response = {
      statusCode: 200,
      headers: {
        ...baseHeaders,
        ...cacheHeaders,
        'X-Total-Count': String(taxDates.length),
        'X-Query-Type': hasFilters ? 'filtered' : 'base',
        'X-Query-Time': `${queryTime}ms`,
        'X-Response-Time': `${totalResponseTime}ms`,
        'X-Region': process.env.AWS_REGION || 'unknown',
      },
      body: JSON.stringify({
        country: countryUpper,
        year: parseInt(year),
        filters: {
          type: type || null,
          state: state || null,
          agency: agency || null,
          frequency: frequency || null,
        },
        totalDates: taxDates.length,
        dates: taxDates,
        _metadata: {
          queryTime: `${queryTime}ms`,
          totalTime: `${totalResponseTime}ms`,
          cached: isCacheHit,
          region: process.env.AWS_REGION,
        },
      }),
    };

    // Wait for metrics to complete (but with timeout)
    await Promise.race([
      metricsPromise,
      new Promise(resolve => setTimeout(resolve, 100)), // 100ms timeout
    ]);

    return response;
  } catch (error) {
    console.error('Error processing request:', error);
    
    const errorTime = Date.now() - startTime;
    await sendMetrics('error', errorTime, 0, 'no-cache', 500);

    return {
      statusCode: 500,
      headers: {
        ...baseHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Error': 'Internal Server Error',
      },
      body: JSON.stringify({
        error: 'Internal server error',
      }),
    };
  }
};