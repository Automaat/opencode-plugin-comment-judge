export type Item = { sku: string; price: number; quantity: number };

export type Cart = { items: Item[]; currency: string };

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function addItem(cart: Cart, item: Item): Cart {
  const existing = cart.items.find((candidate) => candidate.sku === item.sku);
  if (!existing) return { ...cart, items: [...cart.items, item] };
  return {
    ...cart,
    items: cart.items.map((candidate) =>
      candidate.sku === item.sku
        ? { ...candidate, quantity: candidate.quantity + item.quantity }
        : candidate,
    ),
  };
}
