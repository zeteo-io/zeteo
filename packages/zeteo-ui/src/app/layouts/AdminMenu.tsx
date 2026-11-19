import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { NavLink, useLocation } from "react-router-dom";
import { ADMIN_SECTIONS, isListed } from "../sections";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@tereo-io/react";
import "./AdminMenu.css";

/** The top bar's Admin menu: the admin sections the person may see, or nothing. */
export const AdminMenu = () => {
  const { hasPermission } = useAuth();
  const { pathname } = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const visible = ADMIN_SECTIONS.filter((s) => isListed(s, hasPermission));
  const isActive = visible.some(
    (s) => pathname === s.path || pathname.startsWith(`${s.path}/`)
  );

  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setIsOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  if (visible.length === 0) return null;

  return (
    <div ref={menuRef} className="z-admin-menu-container">
      <button
        ref={buttonRef}
        type="button"
        className={`k-app-top-bar-link z-admin-trigger${isActive ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>Admin</span>
        <FontAwesomeIcon icon={faChevronDown} className="z-admin-chevron" />
      </button>

      {isOpen && (
        <div className="z-admin-menu">
          {visible.map((s) => (
            <NavLink
              key={s.path}
              to={s.path}
              className="z-admin-menu-item"
              onClick={() => setIsOpen(false)}
            >
              {s.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
};
