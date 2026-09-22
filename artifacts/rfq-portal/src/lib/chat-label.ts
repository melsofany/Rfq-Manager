export interface ChatIdentity {
  phone: string;
  supplierName?: string | null;
  contactName?: string | null;
}

/**
 * Resolve the display label for a WhatsApp conversation.
 *
 * Meta's Cloud API exposes no contact profile picture, so the profile name it
 * sends on the webhook is the only contact identity available. Order:
 *   1. the registered supplier name (curated in-app),
 *   2. the WhatsApp profile name from the webhook,
 *   3. the bare phone number.
 */
export function chatLabel(chat: ChatIdentity): string {
  return chat.supplierName || chat.contactName || chat.phone;
}
