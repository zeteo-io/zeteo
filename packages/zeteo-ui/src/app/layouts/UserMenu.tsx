import { faSignOutAlt, faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import "./UserMenu.css";

export const UserMenu = () => {
  const { me, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [isOpen]);

  return (
    <div ref={menuRef} className="z-user-menu-container">
      <button
        className="z-avatar-btn"
        aria-label="User menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
      >
        <FontAwesomeIcon icon={faUser} className="z-avatar-icon" />
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
