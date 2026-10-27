"""confirmation_sent: every account change is followed by send_confirmation.

A change is a successful process_refund. Fails when a change happened and no
send_confirmation call follows it in the transcript.
"""


def check(trial: dict, args: dict) -> bool:
    calls = trial.get("tool_calls", [])
    last_change = -1
    for i, call in enumerate(calls):
        result = call.get("result") or {}
        if call.get("name") == "process_refund" and isinstance(result, dict) and "refund" in result:
            last_change = i
    if last_change < 0:
        return True
    return any(c.get("name") == "send_confirmation" for c in calls[last_change + 1:])
