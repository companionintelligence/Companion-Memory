import { Sidebar, cn } from '@ci/shadcn';
import { type LucideIcon } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

interface Props {
  title?: string;
  visibleWhenCollapsed?: boolean;
  items: {
    name: string;
    url: string;
    icon: LucideIcon;
  }[];
}

export function NavSection({ items, title, visibleWhenCollapsed = true }: Props) {
  const location = useLocation();

  return (
    <Sidebar.Group className={cn('py-2', !visibleWhenCollapsed && 'group-data-[collapsible=icon]:hidden')}>
      {title && <Sidebar.GroupLabel>{title}</Sidebar.GroupLabel>}
      <Sidebar.Menu>
        {items.map((item) => (
          <Sidebar.MenuItem key={item.name}>
            <Sidebar.MenuButton tooltip={item.name} isActive={location.pathname === item.url} asChild>
              <Link to={item.url}>
                <item.icon />
                <span>{item.name}</span>
              </Link>
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        ))}
      </Sidebar.Menu>
    </Sidebar.Group>
  );
}
