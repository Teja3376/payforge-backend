import { ValidationError } from 'class-validator';

export function validationMessages(errors: ValidationError[], parent = ''): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) {
      for (const [key, text] of Object.entries(error.constraints)) {
        messages.push(key === 'whitelistValidation' ? `${field} is not allowed.` : text);
      }
    }
    if (error.children?.length) {
      messages.push(...validationMessages(error.children, field));
    }
  }
  return messages;
}
