export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const numberFormatter = new Intl.NumberFormat('zh-CN');
const costFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });

export function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date);
}

export function deadline(value) {
  return time(value);
}

export function number(value) {
  return numberFormatter.format(Number(value) || 0);
}

export function cost(value) {
  return costFormatter.format(Number(value) || 0);
}

/** Small dependency-free Markdown renderer for chat previews. */
export function renderMarkdown(text) {
  let html = esc(text || '');
  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return html.replace(/\n/g, '<br>');
}
