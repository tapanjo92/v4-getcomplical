import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { australiaTaxData } from './au-tax-data';
import { newZealandTaxData } from './nz-tax-data';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TAX_DATA_TABLE = process.env.TAX_DATA_TABLE!;

interface TaxDataItem {
  pk: string;
  sk: string;
  date: string;
  name: string;
  description: string;
  type: string;
  agency: string;
  state?: string;
  states?: string[];
  frequency: string;
  threshold?: string;
  country: string;
  year: number;
  isPublicHoliday?: boolean;
  isBusinessDay?: boolean;
}

export const handler = async (event: any) => {
  console.log('Loading tax data:', JSON.stringify(event, null, 2));

  try {
    const { country, year, mode = 'full' } = event;
    
    if (!country || !year) {
      throw new Error('Country and year parameters are required');
    }

    let dataToLoad: TaxDataItem[] = [];

    if (country === 'AU' || country === 'ALL') {
      dataToLoad = [...dataToLoad, ...transformAustralianData(year)];
    }

    if (country === 'NZ' || country === 'ALL') {
      dataToLoad = [...dataToLoad, ...transformNewZealandData(year)];
    }

    if (dataToLoad.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'No data found for specified country/year' }),
      };
    }

    // Load data in batches of 25 (DynamoDB limit)
    const batches = [];
    for (let i = 0; i < dataToLoad.length; i += 25) {
      batches.push(dataToLoad.slice(i, i + 25));
    }

    let totalLoaded = 0;
    for (const batch of batches) {
      const params = {
        RequestItems: {
          [TAX_DATA_TABLE]: batch.map(item => ({
            PutRequest: {
              Item: item,
            },
          })),
        },
      };

      await docClient.send(new BatchWriteCommand(params));
      totalLoaded += batch.length;
      console.log(`Loaded ${totalLoaded}/${dataToLoad.length} items`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Tax data loaded successfully',
        itemsLoaded: totalLoaded,
        country,
        year,
      }),
    };
  } catch (error) {
    console.error('Error loading tax data:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to load tax data',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

function transformAustralianData(year: number): TaxDataItem[] {
  const data = australiaTaxData[year];
  if (!data) return [];

  const items: TaxDataItem[] = [];

  // Transform federal data
  data.federal.forEach(item => {
    const sk = `${item.date}#${item.type}#${item.agency.toLowerCase()}-${items.length}`;
    items.push({
      pk: `AU#${year}`,
      sk,
      date: item.date,
      name: item.name,
      description: item.description,
      type: item.type,
      agency: item.agency,
      states: ['ALL'],
      frequency: item.frequency,
      threshold: item.threshold,
      country: 'AU',
      year,
      isPublicHoliday: false,
      isBusinessDay: true,
    });
  });

  // Transform state data
  Object.entries(data.states).forEach(([state, stateData]) => {
    stateData.forEach(item => {
      const sk = `${item.date}#${item.type}#${item.agency.toLowerCase()}-${state.toLowerCase()}-${items.length}`;
      items.push({
        pk: `AU#${year}`,
        sk,
        date: item.date,
        name: `${state} - ${item.name}`,
        description: item.description,
        type: item.type,
        agency: item.agency,
        state,
        states: [state],
        frequency: item.frequency,
        threshold: item.threshold,
        country: 'AU',
        year,
        isPublicHoliday: false,
        isBusinessDay: true,
      });
    });
  });

  return items;
}

function transformNewZealandData(year: number): TaxDataItem[] {
  const data = newZealandTaxData[year];
  if (!data) return [];

  const items: TaxDataItem[] = [];

  data.forEach(item => {
    const sk = `${item.date}#${item.type}#ird-${items.length}`;
    items.push({
      pk: `NZ#${year}`,
      sk,
      date: item.date,
      name: item.name,
      description: item.description,
      type: item.type,
      agency: 'IRD',
      states: ['ALL'],
      frequency: item.frequency,
      threshold: item.threshold,
      country: 'NZ',
      year,
      isPublicHoliday: false,
      isBusinessDay: true,
    });
  });

  return items;
}