export function formatPath(path: string) {
  // Extract meaningful parts from the path
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 3) {
    return `.../${parts.slice(-3).join('/')}`;
  }

  return path;
}

export function truncateText(text: string, maxLength: number = 150) {
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength) + '...';
}
