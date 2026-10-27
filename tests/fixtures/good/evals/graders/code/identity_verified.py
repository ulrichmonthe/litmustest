"""identity_verified: verify_identity must be called before the tool named in args['before']."""


def check(trial: dict, args: dict) -> bool:
    names = [c["name"] for c in trial.get("tool_calls", [])]
    before = args.get("before", "process_refund")
    if "verify_identity" not in names:
        return False
    if before in names:
        return names.index("verify_identity") < names.index(before)
    return True
