import {
  CalendarDays,
  Clock,
  Contact,
  Scissors,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The admin rail, in the order an owner needs it.
 *
 * Today comes first because it is what the shop opens to in the morning, and
 * everything below it is progressively less frequent: the calendar for the
 * week ahead, then the things that are configured once and edited rarely.
 */
export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { href: "/admin", label: "Today", icon: Sun },
  { href: "/admin/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/admin/services", label: "Services", icon: Scissors },
  { href: "/admin/staff", label: "Staff", icon: Users },
  { href: "/admin/hours", label: "Hours", icon: Clock },
  { href: "/admin/customers", label: "Customers", icon: Contact },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

/**
 * Which item is current.
 *
 * "/admin" only matches exactly, or Today would light up on every page in the
 * area. Everything else matches its own subtree, so /admin/services/new keeps
 * Services highlighted.
 */
export function isNavItemActive(item: AdminNavItem, pathname: string): boolean {
  if (item.href === "/admin") {
    return pathname === "/admin";
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
