export const ticketUrgencies = ['low', 'normal', 'high', 'urgent'] as const;
export const ticketCategories = ['interface', 'functionality', 'account', 'performance', 'other'] as const;
export const ticketImageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_TICKET_IMAGES = 4;
export const MAX_TICKET_IMAGE_BYTES = 5 * 1024 * 1024;
