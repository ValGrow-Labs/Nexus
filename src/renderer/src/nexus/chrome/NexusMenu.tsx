import { Icon } from '../icons';
import { navigate, useRoute } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { Popover } from '../ui/Sheet';
import { MENU_GROUPS, type NavItem } from './navItems';

/** The "Nexus" wordmark: opens the menu of places (MENU_GROUPS). Planned
 *  places are listed in their own group and say so. */
export function NexusMenu() {
  const route = useRoute();
  const actions = useShellActions();

  const run = (item: NavItem) => {
    if (item.route) { navigate(item.route); return; }
    if (item.id === 'integrations') { actions.openSettings('Connections'); return; }
    if (item.action === 'openSettings') { actions.openSettings(); return; }
    if (item.action === 'openIde') { actions.openIde(); return; }
    if (item.action) actions[item.action]();
  };

  return (
    <Popover
      kind="menu"
      label="Nexus"
      triggerLabel="Nexus menu"
      triggerClassName="nx-bar__brand nx-menu-trigger"
      trigger={<>Nexus<Icon name="chevronRight" size={14} className="nx-menu-trigger__chev" /></>}
    >
      {(close) => MENU_GROUPS.map((g) => (
        <div key={g.label} role="group" aria-label={g.label} className="nx-menu__group">
          <div className="nx-menu__label" aria-hidden="true">{g.label}</div>
          {g.items.map((item) => {
            const current = item.route?.name === route.name;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`nx-menu__item${current ? ' is-current' : ''}`}
                aria-current={current ? 'page' : undefined}
                onClick={() => { close(); run(item); }}
              >
                <Icon name={item.icon} size={16} />
                <span className="nx-menu__text">{item.label}</span>
                {item.planned && <span className="nx-menu__note">Coming later</span>}
              </button>
            );
          })}
        </div>
      ))}
    </Popover>
  );
}
