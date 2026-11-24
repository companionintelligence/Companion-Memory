/**
 * The note page's text helpers, shared by the appliance-backed page and the
 * phone's local one (`LocalNotePage`).
 */

/** "5m ago"-style words for the save status. */
export function shortFormatter(value: string, unit: string) {
  switch (unit) {
    case 'second':
      return `${value}s ago`;
    case 'minute':
      return `${value}m ago`;
    case 'hour':
      return `${value}h ago`;
    case 'day':
      return `${value}d ago`;
    case 'week':
      return `${value}w ago`;
    case 'month':
      return `${value}mo ago`;
    case 'year':
      return `${value}y ago`;
    default:
      return '';
  }
}

export function hasContent(content: string) {
  return content.replace(/<[^>]*>/g, '').trim().length > 0;
}

export function extractTitle(content: string) {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const div = doc.body;

  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    if (node.textContent?.trim()) {
      let element = node.parentElement;
      while (element && element !== div) {
        if (
          ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV'].includes(
            element.tagName,
          )
        ) {
          return element.textContent?.trim().substring(0, 100) || 'Untitled note';
        }

        element = element.parentElement;
      }

      return node.textContent?.trim().substring(0, 100) || 'Untitled note';
    }

    node = walker.nextNode();
  }

  return 'Untitled note';
}
