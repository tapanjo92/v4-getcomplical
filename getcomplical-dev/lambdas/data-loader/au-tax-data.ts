interface AustralianTaxDate {
  date: string;
  name: string;
  description: string;
  type: string;
  agency: string;
  frequency: string;
  threshold?: string;
}

interface AustralianTaxData {
  federal: AustralianTaxDate[];
  states: {
    [state: string]: AustralianTaxDate[];
  };
}

export const australiaTaxData: { [year: number]: AustralianTaxData } = {
  2024: {
    federal: [
      // BAS Quarterly (for businesses with GST turnover < $20M)
      {
        date: '2024-02-28',
        name: 'December Quarter BAS',
        description: 'Lodge and pay December quarter Business Activity Statement',
        type: 'bas',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: 'GST turnover < $20M',
      },
      {
        date: '2024-04-28',
        name: 'March Quarter BAS',
        description: 'Lodge and pay March quarter Business Activity Statement',
        type: 'bas',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: 'GST turnover < $20M',
      },
      {
        date: '2024-07-28',
        name: 'June Quarter BAS',
        description: 'Lodge and pay June quarter Business Activity Statement',
        type: 'bas',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: 'GST turnover < $20M',
      },
      {
        date: '2024-10-28',
        name: 'September Quarter BAS',
        description: 'Lodge and pay September quarter Business Activity Statement',
        type: 'bas',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: 'GST turnover < $20M',
      },
      
      // Super Guarantee Quarterly
      {
        date: '2024-01-28',
        name: 'Q2 Super Guarantee',
        description: 'Super guarantee contributions due for Oct-Dec quarter',
        type: 'super',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: null,
      },
      {
        date: '2024-04-28',
        name: 'Q3 Super Guarantee',
        description: 'Super guarantee contributions due for Jan-Mar quarter',
        type: 'super',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: null,
      },
      {
        date: '2024-07-28',
        name: 'Q4 Super Guarantee',
        description: 'Super guarantee contributions due for Apr-Jun quarter',
        type: 'super',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: null,
      },
      {
        date: '2024-10-28',
        name: 'Q1 Super Guarantee',
        description: 'Super guarantee contributions due for Jul-Sep quarter',
        type: 'super',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: null,
      },
      
      // PAYG Withholding Monthly (large withholders)
      {
        date: '2024-01-21',
        name: 'December PAYG Withholding',
        description: 'PAYG withholding for large withholders',
        type: 'payg-w',
        agency: 'ATO',
        frequency: 'monthly',
        threshold: 'Large withholders',
      },
      {
        date: '2024-02-21',
        name: 'January PAYG Withholding',
        description: 'PAYG withholding for large withholders',
        type: 'payg-w',
        agency: 'ATO',
        frequency: 'monthly',
        threshold: 'Large withholders',
      },
      
      // Annual Returns
      {
        date: '2024-07-31',
        name: 'Individual Tax Return',
        description: 'Lodge 2023-24 individual income tax return',
        type: 'filing',
        agency: 'ATO',
        frequency: 'annual',
        threshold: null,
      },
      {
        date: '2024-10-31',
        name: 'Individual Tax Return (Tax Agent)',
        description: 'Extended deadline for tax agent lodgments',
        type: 'filing',
        agency: 'ATO',
        frequency: 'annual',
        threshold: null,
      },
      {
        date: '2024-02-28',
        name: 'Company Tax Return',
        description: 'Company income tax return (standard balance date)',
        type: 'company-tax',
        agency: 'ATO',
        frequency: 'annual',
        threshold: null,
      },
      
      // FBT
      {
        date: '2024-05-21',
        name: 'FBT Return',
        description: 'Fringe Benefits Tax annual return',
        type: 'fbt',
        agency: 'ATO',
        frequency: 'annual',
        threshold: null,
      },
      
      // PAYG Instalments
      {
        date: '2024-02-21',
        name: 'PAYG Instalment Q2',
        description: 'PAYG instalment for October-December quarter',
        type: 'payg-i',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: null,
      },
      {
        date: '2024-04-28',
        name: 'PAYG Instalment Q3',
        description: 'PAYG instalment for January-March quarter',
        type: 'payg-i',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: null,
      },
      
      // TPAR
      {
        date: '2024-08-28',
        name: 'TPAR Lodgment',
        description: 'Taxable Payments Annual Report for building and construction',
        type: 'tpar',
        agency: 'ATO',
        frequency: 'annual',
        threshold: 'Building & construction businesses',
      },
      
      // ASIC
      {
        date: '2024-01-31',
        name: 'ASIC Annual Review',
        description: 'Company annual review date (if registered in January)',
        type: 'compliance',
        agency: 'ASIC',
        frequency: 'annual',
        threshold: null,
      },
    ],
    
    states: {
      NSW: [
        {
          date: '2024-01-07',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'Revenue NSW',
          frequency: 'monthly',
          threshold: '$1.2M annual wages',
        },
        {
          date: '2024-02-07',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'Revenue NSW',
          frequency: 'monthly',
          threshold: '$1.2M annual wages',
        },
        {
          date: '2024-03-31',
          name: 'Land Tax Assessment',
          description: 'Land tax assessment issued for 2024',
          type: 'land-tax',
          agency: 'Revenue NSW',
          frequency: 'annual',
          threshold: 'Land value > $1,075,000',
        },
        {
          date: '2024-06-30',
          name: 'Workers Compensation',
          description: 'Annual workers compensation premium',
          type: 'workers-comp',
          agency: 'icare NSW',
          frequency: 'annual',
          threshold: null,
        },
      ],
      
      VIC: [
        {
          date: '2024-01-21',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'SRO Victoria',
          frequency: 'monthly',
          threshold: '$900K annual wages',
        },
        {
          date: '2024-02-21',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'SRO Victoria',
          frequency: 'monthly',
          threshold: '$900K annual wages',
        },
        {
          date: '2024-05-15',
          name: 'Land Tax Assessment',
          description: 'Land tax assessment issued for 2024',
          type: 'land-tax',
          agency: 'SRO Victoria',
          frequency: 'annual',
          threshold: 'Land value > $300,000',
        },
      ],
      
      QLD: [
        {
          date: '2024-01-07',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'QRO',
          frequency: 'monthly',
          threshold: '$1.3M annual wages',
        },
        {
          date: '2024-02-07',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'QRO',
          frequency: 'monthly',
          threshold: '$1.3M annual wages',
        },
        {
          date: '2024-10-31',
          name: 'Land Tax Assessment',
          description: 'Land tax assessment issued for 2024-25',
          type: 'land-tax',
          agency: 'QRO',
          frequency: 'annual',
          threshold: 'Land value > $600,000',
        },
      ],
      
      SA: [
        {
          date: '2024-01-21',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'RevenueSA',
          frequency: 'monthly',
          threshold: '$1.5M annual wages',
        },
        {
          date: '2024-06-30',
          name: 'Land Tax Assessment',
          description: 'Land tax assessment for 2024-25',
          type: 'land-tax',
          agency: 'RevenueSA',
          frequency: 'annual',
          threshold: 'Land value > $534,000',
        },
        {
          date: '2024-08-31',
          name: 'ReturnToWorkSA Premium',
          description: 'Annual workers compensation premium',
          type: 'workers-comp',
          agency: 'ReturnToWorkSA',
          frequency: 'annual',
          threshold: null,
        },
      ],
      
      WA: [
        {
          date: '2024-01-21',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'RevenueWA',
          frequency: 'monthly',
          threshold: '$1M annual wages',
        },
        {
          date: '2024-06-30',
          name: 'Land Tax Assessment',
          description: 'Land tax assessment for 2024-25',
          type: 'land-tax',
          agency: 'RevenueWA',
          frequency: 'annual',
          threshold: 'Land value > $300,000',
        },
        {
          date: '2024-07-31',
          name: 'WorkCover Premium',
          description: 'Annual workers compensation premium',
          type: 'workers-comp',
          agency: 'WorkCover WA',
          frequency: 'annual',
          threshold: null,
        },
      ],
      
      TAS: [
        {
          date: '2024-01-21',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'SRO Tasmania',
          frequency: 'monthly',
          threshold: '$1.25M annual wages',
        },
        {
          date: '2024-06-30',
          name: 'Land Tax Assessment',
          description: 'Land tax assessment for 2024-25',
          type: 'land-tax',
          agency: 'SRO Tasmania',
          frequency: 'annual',
          threshold: 'Land value > $50,000',
        },
        {
          date: '2024-08-31',
          name: 'WorkSafe Premium',
          description: 'Annual workers compensation premium',
          type: 'workers-comp',
          agency: 'WorkSafe Tasmania',
          frequency: 'annual',
          threshold: null,
        },
      ],
      
      NT: [
        {
          date: '2024-01-21',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'Territory Revenue',
          frequency: 'monthly',
          threshold: '$1.5M annual wages (increases to $2.5M from July 2025)',
        },
        {
          date: '2024-06-30',
          name: 'NT WorkSafe Premium',
          description: 'Annual workers compensation premium',
          type: 'workers-comp',
          agency: 'NT WorkSafe',
          frequency: 'annual',
          threshold: null,
        },
      ],
      
      ACT: [
        {
          date: '2024-01-07',
          name: 'Payroll Tax Return',
          description: 'Monthly payroll tax return and payment',
          type: 'payroll',
          agency: 'ACT Revenue',
          frequency: 'monthly',
          threshold: '$2M annual wages',
        },
        {
          date: '2024-02-15',
          name: 'Land Tax Quarterly',
          description: 'Quarterly land tax payment',
          type: 'land-tax',
          agency: 'ACT Revenue',
          frequency: 'quarterly',
          threshold: 'AUV > $0 for commercial',
        },
        {
          date: '2024-08-31',
          name: 'WorkSafe ACT Premium',
          description: 'Annual workers compensation premium',
          type: 'workers-comp',
          agency: 'WorkSafe ACT',
          frequency: 'annual',
          threshold: null,
        },
      ],
    },
  },
  
  2025: {
    federal: [
      // Copy similar structure for 2025 with updated dates
      {
        date: '2025-02-28',
        name: 'December Quarter BAS',
        description: 'Lodge and pay December quarter Business Activity Statement',
        type: 'bas',
        agency: 'ATO',
        frequency: 'quarterly',
        threshold: 'GST turnover < $20M',
      },
      // ... more federal dates
    ],
    states: {
      // ... state dates for 2025
    },
  },
};