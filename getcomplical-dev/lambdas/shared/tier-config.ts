/**
 * Tier configuration for GetComplical API
 * This is the single source of truth for all tier-related limits
 */

export interface TierConfig {
  name: string;
  dailyLimit: number;
  rateLimit: number;  // requests per second
  burstLimit: number; // concurrent requests
  price: number;      // monthly price in USD
  features: string[];
}

export const TIER_CONFIGS: Record<string, TierConfig> = {
  free: {
    name: 'Free',
    dailyLimit: 1000,
    rateLimit: 10,
    burstLimit: 20,
    price: 0,
    features: [
      '1,000 requests per day',
      '10 requests per second',
      'Community support',
      'AU & NZ tax data',
    ],
  },
  starter: {
    name: 'Starter',
    dailyLimit: 10000,
    rateLimit: 50,
    burstLimit: 100,
    price: 49,
    features: [
      '10,000 requests per day',
      '50 requests per second',
      'Email support',
      'API usage analytics',
      'Webhook notifications',
    ],
  },
  pro: {
    name: 'Professional',
    dailyLimit: 100000,
    rateLimit: 200,
    burstLimit: 400,
    price: 199,
    features: [
      '100,000 requests per day',
      '200 requests per second',
      'Priority support',
      'Advanced analytics',
      'Custom integrations',
      '99.9% SLA',
    ],
  },
  enterprise: {
    name: 'Enterprise',
    dailyLimit: -1, // unlimited
    rateLimit: 1000,
    burstLimit: 2000,
    price: -1, // custom pricing
    features: [
      'Unlimited requests',
      '1000 requests per second',
      'Dedicated support',
      'Custom data sources',
      'On-premise deployment',
      '99.99% SLA',
    ],
  },
};

/**
 * Get tier configuration with fallback to free tier
 */
export function getTierConfig(tier?: string): TierConfig {
  return TIER_CONFIGS[tier || 'free'] || TIER_CONFIGS.free;
}

/**
 * Check if a tier allows a certain number of daily requests
 */
export function isWithinTierLimit(tier: string, currentUsage: number): boolean {
  const config = getTierConfig(tier);
  if (config.dailyLimit === -1) return true; // unlimited
  return currentUsage < config.dailyLimit;
}