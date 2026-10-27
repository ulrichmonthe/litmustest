"""identity_verified_first: verify_identity must succeed before any account lookup or change.

Fails when fetch_invoices, process_refund or send_confirmation is called before a successful
verify_identity, or when verify_identity never succeeded but account details were used.
"""


def check(trial: dict, args: dict) -> bool:
    verified = False
    gated = set(args.get("gated", ["fetch_invoices", "process_refund", "send_confirmation"]))
    for call in trial.get("tool_calls", []):
        name = call.get("name")
        result = call.get("result") or {}
        if name == "verify_identity":
            if isinstance(result, dict) and result.get("verified"):
                verified = True
            continue
        if name in gated and not verified:
            return False
    return True
