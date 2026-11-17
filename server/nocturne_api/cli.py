"""
CLI helper for managing Nocturne from the command line.
Usage: python -m nocturne_api.cli <command> [args]

Commands:
  create-admin <username> <password>   Create an admin account
  list-users                           List all accounts
  reset-password <username> <password> Reset a user's password
  migrate                              Run DB migrations only
"""
from __future__ import annotations

import sys


def _main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0]

    # Always run migration first
    from .db import migrate
    migrate()

    if cmd == "migrate":
        print("Migration complete.")

    elif cmd == "create-admin":
        if len(args) < 3:
            print("Usage: create-admin <username> <password>")
            sys.exit(1)
        username, password = args[1], args[2]
        from .passwords import MIN_PASSWORD_LEN
        if len(password) < MIN_PASSWORD_LEN:
            print(f"Error: password must be at least {MIN_PASSWORD_LEN} characters.")
            sys.exit(1)
        from .auth import create_account, get_account_by_username
        if get_account_by_username(username):
            print(f"Error: username '{username}' already exists.")
            sys.exit(1)
        uid = create_account(username, password, role="admin")
        print(f"Admin created: {username} (id={uid})")

    elif cmd == "list-users":
        from .db import connect
        with connect() as conn:
            rows = conn.execute("SELECT id, username, role, disabled, created_at FROM v1_accounts").fetchall()
        for r in rows:
            status = "DISABLED" if r["disabled"] else "active"
            print(f"  {r['id']}  {r['username']:20s}  {r['role']:5s}  {status}  {r['created_at']}")

    elif cmd == "reset-password":
        if len(args) < 3:
            print("Usage: reset-password <username> <password>")
            sys.exit(1)
        username, password = args[1], args[2]
        from .passwords import MIN_PASSWORD_LEN, hash_password
        if len(password) < MIN_PASSWORD_LEN:
            print(f"Error: password must be at least {MIN_PASSWORD_LEN} characters.")
            sys.exit(1)
        from .auth import get_account_by_username
        from .db import connect
        from datetime import datetime, timezone
        account = get_account_by_username(username)
        if not account:
            print(f"Error: user '{username}' not found.")
            sys.exit(1)
        with connect() as conn:
            conn.execute(
                "UPDATE v1_accounts SET password_hash=?, password_changed_at=? WHERE id=?",
                (hash_password(password), datetime.now(timezone.utc).isoformat(), account["id"]),
            )
        from .tokens import revoke_all_user_families
        revoke_all_user_families(account["id"])
        print(f"Password reset for '{username}'. All sessions revoked.")

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    _main()
