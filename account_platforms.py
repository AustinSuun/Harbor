"""Account platform assignments and the manual ChatGPT browser entry point."""
from pathlib import Path

CHATGPT_HOME = 'https://chatgpt.com/'
CHATGPT_LOGIN = 'https://chatgpt.com/auth/login'


def initialize(db):
    # A separate table keeps legacy account rows and credential migrations intact.
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS account_platforms (account_id TEXT PRIMARY KEY, platform TEXT NOT NULL CHECK(platform IN ('arena','chatgpt')))")


def platform_for(db, account_id):
    row = db.execute('SELECT platform FROM account_platforms WHERE account_id=?', (account_id,)).fetchone()
    return row[0] if row else 'arena'


def assign(db, account_id, platform):
    db.execute('INSERT INTO account_platforms (account_id,platform) VALUES (?,?)', (account_id, platform))


async def open_initial_page(page, profile: Path):
    # This marker only records opening the profile, never a claim of login success.
    marker = profile / '.chatgpt-opened'
    await page.goto(CHATGPT_HOME if marker.exists() else CHATGPT_LOGIN,
                    wait_until='domcontentloaded', timeout=20000)
    await page.bring_to_front()
    marker.touch()
