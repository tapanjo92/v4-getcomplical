import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TAX_DATA_TABLE = process.env.TAX_DATA_TABLE!;

// Cache configuration based on query type
const getCacheHeaders = (hasTypeFilter: boolean): Record<string, string> => {
  if (hasTypeFilter) {
    // Shorter cache for filtered queries (6 hours)
    return {
      'Cache-Control': 'public, max-age=21600, s-maxage=21600',
      'Surrogate-Control': 'max-age=21600',
      'X-Cache-Strategy': 'filtered-query',
    };
  } else {
    // Longer cache for popular queries (24 hours)
    return {
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      'Surrogate-Control': 'max-age=86400',
      'X-Cache-Strategy': 'popular-query',
    };
  }
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('API event:', JSON.stringify(event, null, 2));

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };

  try {
    const { country, year, type, state, agency, frequency } = event.queryStringParameters || {};

    if (!country || !year) {
      return {
        statusCode: 400,
        headers: {
          ...baseHeaders,
          'Cache-Control': 'no-cache, no-store',
        },
        body: JSON.stringify({
          error: 'Missing required parameters: country and year',
        }),
      };
    }

    const countryUpper = country.toUpperCase();
    if (!['AU', 'NZ'].includes(countryUpper)) {
      return {
        statusCode: 400,
        headers: {
          ...baseHeaders,
          'Cache-Control': 'no-cache, no-store',
        },
        body: JSON.stringify({
          error: 'Country must be AU or NZ',
        }),
      };
    }

    const pk = `${countryUpper}#${year}`;
    const hasFilters = !!(type || state || agency || frequency);
    
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

    const { Items = [] } = await docClient.send(new QueryCommand(queryParams));

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
    const cacheHeaders = getCacheHeaders(hasFilters);

    return {
      statusCode: 200,
      headers: {
        ...baseHeaders,
        ...cacheHeaders,
        'X-Total-Count': String(taxDates.length),
        'X-Query-Type': hasFilters ? 'filtered' : 'base',
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
      }),
    };
  } catch (error) {
    console.error('Error processing request:', error);
    return {
      statusCode: 500,
      headers: {
        ...baseHeaders,
        'Cache-Control': 'no-cache, no-store',
      },
      body: JSON.stringify({
        error: 'Internal server error',
      }),
    };
  }
};