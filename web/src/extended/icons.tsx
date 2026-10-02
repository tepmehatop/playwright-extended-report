import * as React from 'react';
import type { ExtendedTabIcon } from '../../../src/shared/tabsFormat';

// 16x16 icons drawn to match the octicons used across the report.
const svg = (children: React.ReactNode) => <svg aria-hidden='true' height='16' viewBox='0 0 16 16' width='16' className='octicon' fill='currentColor'>{children}</svg>;

const icons: Record<Exclude<ExtendedTabIcon, 'none'>, () => React.JSX.Element> = {
  sparkle: () => svg(<>
    <path d='M6.5 1 7.9 5.1 12 6.5 7.9 7.9 6.5 12 5.1 7.9 1 6.5 5.1 5.1Z' />
    <path d='M12.5 9.5 13.2 11.3 15 12 13.2 12.7 12.5 14.5 11.8 12.7 10 12 11.8 11.3Z' />
  </>),
  bug: () => svg(<>
    <path d='M8 3.5a2 2 0 0 0-2 2h4a2 2 0 0 0-2-2Zm-3.5 3h7v4a3.5 3.5 0 0 1-7 0v-4Zm1.5 1.5v2.5a2 2 0 0 0 4 0V8Z' fillRule='evenodd' />
    <path d='M1.5 7.25h2.25v1.5H1.5Zm10.75 0h2.25v1.5h-2.25ZM2 11.6l1.8-.9.7 1.3-1.8.9Zm12 0-1.8-.9-.7 1.3 1.8.9ZM2 4.4l1.8.9.7-1.3-1.8-.9Zm12 0-1.8.9-.7-1.3 1.8-.9Z' />
  </>),
  graph: () => svg(<path d='M1.5 1.75a.75.75 0 0 1 1.5 0V13h11.25a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Zm3 6.25h2v4h-2Zm3.25-3h2v7h-2ZM11 7h2v5h-2Z' />),
  note: () => svg(<path d='M3.75 1.5h6.19L13 4.56v9.19a.75.75 0 0 1-.75.75h-8.5a.75.75 0 0 1-.75-.75V2.25a.75.75 0 0 1 .75-.75ZM4.5 3v10h7V5.5H9.5A.75.75 0 0 1 8.75 4.75V3Zm1 4.5h5V9h-5Zm0 2.5h5v1.5h-5Z' fillRule='evenodd' />),
  list: () => svg(<path d='M2 3.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm3 .25h9.25v1.5H5ZM2 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm3 .25h9.25v1.5H5Zm-3 3.25a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm3 .25h9.25v1.5H5Z' />),
};

export function tabIcon(icon: ExtendedTabIcon | undefined): React.JSX.Element | null {
  if (icon === 'none')
    return null;
  return (icons[icon ?? 'note'] ?? icons.note)();
}
