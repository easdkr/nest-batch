export const VALID_CATEGORIES = ['electronics', 'books', 'clothing', 'food'] as const;
export type ProductCategory = typeof VALID_CATEGORIES[number];
export function isValidCategory(s: string): s is ProductCategory {
  return (VALID_CATEGORIES as readonly string[]).includes(s);
}
