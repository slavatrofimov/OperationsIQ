import {
  Button,
  Menu,
  MenuButton,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { isNavItemActive, sectionItems, type NavGroup, type NavItem, type NavPreset } from '../lib/personas';
import type { PageKey } from '../lib/pages';

const useStyles = makeStyles({
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalL,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  item: {
    // Square the bottom so the active underline reads as a tab indicator.
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottom: `2px solid transparent`,
  },
  activeItem: {
    borderBottomColor: tokens.colorBrandStroke1,
    color: tokens.colorBrandForeground1,
  },
  activeMenuItem: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    fontWeight: tokens.fontWeightSemibold,
  },
  groupHeader: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontSize: tokens.fontSizeBase100,
    borderRadius: tokens.borderRadiusSmall,
    marginTop: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  subGroupHeader: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightRegular,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontSize: tokens.fontSizeBase100,
    marginTop: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
  },
});

export interface AppNavProps {
  /** Resolved navigation groups, in display order. */
  groups: NavGroup[];
  /** Currently selected page. */
  current: PageKey;
  /** Preset applied to the current page, used to disambiguate sibling menu items. */
  currentPreset?: NavPreset;
  /** Called when the user picks an item, with its target page and optional preset. */
  onSelect: (page: PageKey, preset?: NavPreset) => void;
}

/**
 * Primary navigation rendered as a compact menu bar. Groups with a single item
 * render as a plain button (tab-style); groups with several items render as a
 * dropdown, with an optional header per section so related capabilities read as
 * a labeled cluster (e.g. Patterns → "Quick interactive discovery" / "Deep
 * discovery").
 */
export function AppNav({ groups, current, currentPreset, onSelect }: AppNavProps) {
  const styles = useStyles();

  return (
    <nav className={styles.bar} aria-label="Primary">
      {groups.map((group) => {
        const items = group.sections.flatMap((s) => sectionItems(s));

        if (items.length === 1) {
          const item = items[0];
          const active = current === item.page;
          return (
            <Button
              key={group.id}
              appearance="subtle"
              className={mergeClasses(styles.item, active && styles.activeItem)}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(item.page, item.preset)}
            >
              {item.label}
            </Button>
          );
        }

        const active = items.some((i) => i.page === current);
        const multiSection = group.sections.length > 1;
        return (
          <Menu key={group.id} positioning="below-start">
            <MenuTrigger disableButtonEnhancement>
              <MenuButton
                appearance="subtle"
                className={mergeClasses(styles.item, active && styles.activeItem)}
                aria-current={active ? 'page' : undefined}
              >
                {group.label}
              </MenuButton>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {group.sections.map((section, si) => {
                  const renderItem = (item: NavItem) => {
                    const itemActive = isNavItemActive(item, current, currentPreset);
                    return (
                      <MenuItem
                        key={item.key}
                        className={itemActive ? styles.activeMenuItem : undefined}
                        aria-current={itemActive ? 'page' : undefined}
                        onClick={() => onSelect(item.page, item.preset)}
                      >
                        {item.label}
                      </MenuItem>
                    );
                  };

                  let body: JSX.Element;
                  if (section.subsections) {
                    // Two-level section: bold parent header, then an indented,
                    // de-emphasized sub-header before each subsection's items.
                    body = (
                      <MenuGroup>
                        {section.header && (
                          <MenuGroupHeader className={styles.groupHeader}>
                            {section.header}
                          </MenuGroupHeader>
                        )}
                        {section.subsections.map((sub, subi) => (
                          <div key={sub.header ?? `sub-${subi}`}>
                            {sub.header && (
                              <MenuGroupHeader className={styles.subGroupHeader}>
                                {sub.header}
                              </MenuGroupHeader>
                            )}
                            {sub.items.map(renderItem)}
                          </div>
                        ))}
                      </MenuGroup>
                    );
                  } else {
                    const rendered = (section.items ?? []).map(renderItem);
                    body = section.header ? (
                      <MenuGroup>
                        <MenuGroupHeader className={styles.groupHeader}>
                          {section.header}
                        </MenuGroupHeader>
                        {rendered}
                      </MenuGroup>
                    ) : (
                      <MenuGroup>{rendered}</MenuGroup>
                    );
                  }

                  return (
                    <div key={section.header ?? `section-${si}`}>
                      {multiSection && si > 0 && <MenuDivider />}
                      {body}
                    </div>
                  );
                })}
              </MenuList>
            </MenuPopover>
          </Menu>
        );
      })}
    </nav>
  );
}
