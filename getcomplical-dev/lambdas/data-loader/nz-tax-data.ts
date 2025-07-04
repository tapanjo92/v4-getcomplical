interface NewZealandTaxDate {
  date: string;
  name: string;
  description: string;
  type: string;
  frequency: string;
  threshold?: string;
}

export const newZealandTaxData: { [year: number]: NewZealandTaxDate[] } = {
  2024: [
    // GST Returns (most common - 2-monthly)
    {
      date: '2024-01-28',
      name: 'GST Return - December',
      description: 'GST return and payment for November-December period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    {
      date: '2024-03-28',
      name: 'GST Return - February',
      description: 'GST return and payment for January-February period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    {
      date: '2024-05-28',
      name: 'GST Return - April',
      description: 'GST return and payment for March-April period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    {
      date: '2024-07-28',
      name: 'GST Return - June',
      description: 'GST return and payment for May-June period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    {
      date: '2024-09-28',
      name: 'GST Return - August',
      description: 'GST return and payment for July-August period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    {
      date: '2024-11-28',
      name: 'GST Return - October',
      description: 'GST return and payment for September-October period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    
    // PAYE (Employer deductions)
    {
      date: '2024-01-20',
      name: 'PAYE Payment - December',
      description: 'PAYE, KiwiSaver, Student Loan deductions for December',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    {
      date: '2024-02-20',
      name: 'PAYE Payment - January',
      description: 'PAYE, KiwiSaver, Student Loan deductions for January',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    {
      date: '2024-03-20',
      name: 'PAYE Payment - February',
      description: 'PAYE, KiwiSaver, Student Loan deductions for February',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    {
      date: '2024-04-20',
      name: 'PAYE Payment - March',
      description: 'PAYE, KiwiSaver, Student Loan deductions for March',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    {
      date: '2024-05-20',
      name: 'PAYE Payment - April',
      description: 'PAYE, KiwiSaver, Student Loan deductions for April',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    {
      date: '2024-04-05',
      name: 'PAYE Payment - March (Small employers)',
      description: 'PAYE for small employers (twice monthly)',
      type: 'paye',
      frequency: 'semi-monthly',
      threshold: 'Small employers <$500k PAYE/year',
    },
    
    // Provisional Tax
    {
      date: '2024-08-28',
      name: 'Provisional Tax - P1',
      description: 'First instalment of provisional tax for 2025 tax year',
      type: 'provisional-tax',
      frequency: '3-instalments',
      threshold: 'Standard method provisional taxpayers',
    },
    {
      date: '2025-01-15',
      name: 'Provisional Tax - P2',
      description: 'Second instalment of provisional tax for 2025 tax year',
      type: 'provisional-tax',
      frequency: '3-instalments',
      threshold: 'Standard method provisional taxpayers',
    },
    {
      date: '2025-05-07',
      name: 'Provisional Tax - P3',
      description: 'Third instalment of provisional tax for 2025 tax year',
      type: 'provisional-tax',
      frequency: '3-instalments',
      threshold: 'Standard method provisional taxpayers',
    },
    
    // Income Tax Returns
    {
      date: '2024-07-07',
      name: 'Individual Tax Return (IR3)',
      description: 'Individual income tax return for 2024 tax year',
      type: 'filing',
      frequency: 'annual',
      threshold: null,
    },
    {
      date: '2024-03-31',
      name: 'Company Tax Return (IR4)',
      description: 'Company tax return (31 March balance date)',
      type: 'company-tax',
      frequency: 'annual',
      threshold: '31 March balance date companies',
    },
    {
      date: '2024-09-30',
      name: 'Company Tax Return (IR4)',
      description: 'Company tax return (30 September balance date)',
      type: 'company-tax',
      frequency: 'annual',
      threshold: '30 September balance date companies',
    },
    
    // FBT
    {
      date: '2024-05-31',
      name: 'FBT Annual Return',
      description: 'Fringe Benefit Tax annual return and payment',
      type: 'fbt',
      frequency: 'annual',
      threshold: 'Employers providing fringe benefits',
    },
    {
      date: '2024-07-31',
      name: 'FBT Q1 Return',
      description: 'FBT quarterly return (Apr-Jun quarter)',
      type: 'fbt',
      frequency: 'quarterly',
      threshold: 'Quarterly FBT filers',
    },
    {
      date: '2024-10-31',
      name: 'FBT Q2 Return',
      description: 'FBT quarterly return (Jul-Sep quarter)',
      type: 'fbt',
      frequency: 'quarterly',
      threshold: 'Quarterly FBT filers',
    },
    
    // Employer Superannuation Contribution Tax (ESCT)
    {
      date: '2024-01-20',
      name: 'ESCT Payment',
      description: 'Employer superannuation contribution tax',
      type: 'esct',
      frequency: 'monthly',
      threshold: 'With PAYE payments',
    },
    
    // KiwiSaver
    {
      date: '2024-01-20',
      name: 'KiwiSaver Contributions',
      description: 'Employer KiwiSaver contributions',
      type: 'kiwisaver',
      frequency: 'monthly',
      threshold: 'With PAYE payments',
    },
    
    // Student Loan
    {
      date: '2024-01-20',
      name: 'Student Loan Deductions',
      description: 'Employee student loan repayments',
      type: 'student-loan',
      frequency: 'monthly',
      threshold: 'With PAYE payments',
    },
  ],
  
  2025: [
    // GST Returns (2-monthly)
    {
      date: '2025-01-28',
      name: 'GST Return - December',
      description: 'GST return and payment for November-December 2024 period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    {
      date: '2025-03-28',
      name: 'GST Return - February',
      description: 'GST return and payment for January-February period',
      type: 'gst',
      frequency: '2-monthly',
      threshold: 'Standard 2-monthly filers',
    },
    
    // PAYE
    {
      date: '2025-01-20',
      name: 'PAYE Payment - December 2024',
      description: 'PAYE, KiwiSaver, Student Loan deductions for December 2024',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    {
      date: '2025-02-20',
      name: 'PAYE Payment - January',
      description: 'PAYE, KiwiSaver, Student Loan deductions for January',
      type: 'paye',
      frequency: 'monthly',
      threshold: 'Monthly PAYE filers',
    },
    
    // Income Tax
    {
      date: '2025-07-07',
      name: 'Individual Tax Return (IR3)',
      description: 'Individual income tax return for 2025 tax year',
      type: 'filing',
      frequency: 'annual',
      threshold: null,
    },
  ],
};