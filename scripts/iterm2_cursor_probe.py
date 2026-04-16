#!/usr/bin/env python3
"""
iTerm2 Python API cursor probe for AgentInbox.
Returns session state including cursor position and buffer contents.
"""

import sys
import json
import asyncio


def probe_session(connection, session_id):
    """Probe iTerm2 session state and return cursor position with buffer contents."""
    try:
        import iterm2

        async def get_session_state():
            try:
                app = await iterm2.async_get_app(connection)
                session = app.get_session_by_id(session_id)

                if not session:
                    return {"status": "gone"}

                screen = await session.async_get_screen_contents()
                cursor = screen.cursor_coord

                # Get the last few lines of content
                lines = []
                start_line = max(0, screen.number_of_lines - 5)
                for i in range(start_line, screen.number_of_lines):
                    try:
                        line = screen.line(i)
                        line_str = line.string if hasattr(line, 'string') else str(line)
                        lines.append(line_str)
                    except Exception:
                        break

                return {
                    "status": "available",
                    "cursor": {"x": cursor.x, "y": cursor.y},
                    "screen_height": screen.number_of_lines,
                    "lines": lines
                }
            except Exception as e:
                return {"status": "error", "error": str(e)}

        return get_session_state()

    except ImportError:
        return {"status": "error", "error": "iterm2 module not installed"}


def main():
    if len(sys.argv) < 2:
        result = {"status": "error", "error": "missing session_id argument"}
        print(json.dumps(result))
        sys.exit(1)

    session_id = sys.argv[1]

    # Try to import iterm2 and run the probe
    try:
        import iterm2
        result = iterm2.run_until_complete(probe_session, session_id)
        print(json.dumps(result))

        # Exit with error code if status is not "available" or "gone"
        if result.get("status") not in ["available", "gone"]:
            sys.exit(1)
        else:
            sys.exit(0)

    except ImportError:
        result = {"status": "error", "error": "iterm2 module not installed"}
        print(json.dumps(result))
        sys.exit(1)
    except Exception as e:
        result = {"status": "error", "error": str(e)}
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()