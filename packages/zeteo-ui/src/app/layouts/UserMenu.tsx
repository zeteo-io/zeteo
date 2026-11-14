import { faSignOutAlt, faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import "./UserMenu.css";

export const UserMenu = () => {
  const { me, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const label = me.name ?? me.email ?? "Signed in";

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

  return (
    <div ref={menuRef} className="z-user-menu-container">
      <button
        ref={buttonRef}
        className="z-avatar-btn"
        aria-expanded={isOpen}
        aria-haspopup="true"
        onClick={() => setIsOpen(!isOpen)}
      >
        <FontAwesomeIcon icon={faUser} className="z-avatar-icon" />
        <span className="z-avatar-label">{label}</span>
      </button>

      <div className={`z-user-menu ${isOpen ? "open" : ""}`}>
        <div className="z-user-menu-header">
          <div className="z-user-menu-name">{me.name ?? me.email ?? me.id}</div>
          {me.name && me.email && (
            <div className="z-user-menu-email">{me.email}</div>
          )}
        </div>
        <button className="z-user-menu-item" onClick={signOut}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
};
