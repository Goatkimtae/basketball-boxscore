"""Ask Claude, shot by shot, for the shooter's jersey number in the three pictures made by make_frames.py.
Key: environment variable HOOPSTAT_CLAUDE_KEY (kept separate from ANTHROPIC_API_KEY so Claude Code itself
does not start using it). Pictures and results live in HOOPSTAT_TEST_DIR (default: this folder); results go to answers_<model>_<effort>.json; finished shots are skipped on a rerun.

    python ask_claude.py [model] [effort] [first N shots]"""
import base64, json, os, sys, time
import anthropic

HERE = os.environ.get('HOOPSTAT_TEST_DIR', os.path.dirname(os.path.abspath(__file__)))   # folder with frames.json and img/
MODEL = sys.argv[1] if len(sys.argv) > 1 else 'claude-opus-5-5'
EFFORT = sys.argv[2] if len(sys.argv) > 2 else 'medium'
LIMIT = int(sys.argv[3]) if len(sys.argv) > 3 else None
PRICE = {'claude-opus-5-5': (4.0, 20.0), 'claude-sonnet-5-5': (2.0, 10.0), 'claude-haiku-5-5': (0.10, 0.50)}   # $ per million tokens in / out

SYSTEM = ('You look at pictures from an amateur basketball game filmed with a phone. '
          'Answer only from what is visible in the pictures; never guess a number you cannot read.')
ASK = ('These three pictures are from one shot attempt, in time order: about 0.3 s before the shooter gathers the ball, '
       'the gather, and about 0.25 s later as the ball goes up. A yellow circle marks the basketball where it could be located '
       '(a picture may have no circle).\n\n'
       'Who holds this ball and shoots it? Read that player\'s jersey number.\n'
       '- Give a number only if you can read it on the shooter\'s own shirt in at least one picture.\n'
       '- A number on another player who stands in front of or next to the shooter does not count.\n'
       '- If the shooter is not in the pictures or the number on the shooter\'s shirt cannot be read, give an empty string.\n'
       'certainty: "high" if the shooter and the number are both clear, "medium" if one of them is somewhat unclear, "low" otherwise.')
SCHEMA = {'type': 'object', 'additionalProperties': False,
          'required': ['shooter_seen', 'number', 'certainty', 'note'],
          'properties': {'shooter_seen': {'type': 'boolean'},
                         'number': {'type': 'string', 'description': 'jersey number of the shooter, 1-2 digits, or empty string'},
                         'certainty': {'type': 'string', 'enum': ['high', 'medium', 'low']},
                         'note': {'type': 'string', 'description': 'one short sentence: where the shooter is and what is visible'}}}


def content_for(shot):
    blocks = []
    for i, name in enumerate(shot['files']):
        with open(os.path.join(HERE, 'img', name), 'rb') as f:
            data = base64.standard_b64encode(f.read()).decode('utf-8')
        blocks.append({'type': 'text', 'text': f'Picture {i + 1}'})
        blocks.append({'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': data}})
    blocks.append({'type': 'text', 'text': ASK})
    return blocks


def main():
    key = os.environ.get('HOOPSTAT_CLAUDE_KEY') or os.environ.get('ANTHROPIC_API_KEY')
    if not key:
        sys.exit('No API key: set HOOPSTAT_CLAUDE_KEY in the environment settings.')
    client = anthropic.Anthropic(api_key=key)
    shots = json.load(open(os.path.join(HERE, 'frames.json')))[:LIMIT]
    out_path = os.path.join(HERE, f'answers_{MODEL}_{EFFORT}.json')
    done = json.load(open(out_path)) if os.path.exists(out_path) else {}
    tin = tout = 0
    for s in shots:
        sid = f"{s['cam']}{s['k']}"
        if sid in done:
            continue
        t0 = time.time()
        try:
            r = client.beta.messages.create(
                model=MODEL, max_tokens=8000, system=SYSTEM,
                messages=[{'role': 'user', 'content': content_for(s)}],
                output_config={'effort': EFFORT, 'format': {'type': 'json_schema', 'schema': SCHEMA}},
                betas=['server-side-fallback-2026-07-01'], fallbacks='default',
            )
        except anthropic.AuthenticationError as e:
            sys.exit(f'API key rejected: {e}')
        except anthropic.RateLimitError:
            time.sleep(20)
            continue
        except anthropic.APIStatusError as e:
            print(sid, 'API error', e.status_code, e.message)
            continue
        except anthropic.APIConnectionError as e:
            print(sid, 'connection error', e)
            continue
        if r.stop_reason == 'refusal':
            ans = {'refused': True, 'category': getattr(r.stop_details, 'category', None)}
        else:
            text = next((b.text for b in r.content if b.type == 'text'), '{}')
            ans = json.loads(text)
        ans.update(model=r.model, stop=r.stop_reason, tokens_in=r.usage.input_tokens, tokens_out=r.usage.output_tokens, secs=round(time.time() - t0, 1))
        tin += r.usage.input_tokens; tout += r.usage.output_tokens
        done[sid] = ans
        json.dump(done, open(out_path, 'w'), ensure_ascii=False, indent=1)
        print(sid, ans.get('number'), ans.get('certainty'), '|', ans.get('note', ''), f"({ans['secs']}s, {ans['tokens_in']}+{ans['tokens_out']} tok)", flush=True)
    p = PRICE.get(MODEL)
    if p:
        print(f'this run: {tin} input + {tout} output tokens = ${tin * p[0] / 1e6 + tout * p[1] / 1e6:.2f}')


if __name__ == '__main__':
    main()
