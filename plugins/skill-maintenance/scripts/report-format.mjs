export function markdownInline(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]()#+.!|<>])/g, '\\$1');
}

export function indentedJson(value) {
  return JSON.stringify(value, null, 2).split('\n').map(line => `    ${line}`).join('\n');
}
