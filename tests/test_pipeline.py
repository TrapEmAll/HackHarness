from hackharness.benchmark import BenchmarkResult, leaderboard
from hackharness.contracts import SpecialistOutput
from hackharness.models import Finding, Verdict
from hackharness.review import ReviewCouncil, ReviewVote
from hackharness.routing import ModelRouter

def test_structured_output():
    out = SpecialistOutput.from_model_text('{"observations":[],"hypotheses":[],"followups":[]}')
    assert out.hypotheses == []

def test_router_escalates_signal():
    r = ModelRouter('local-small', 'strong')
    assert r.route_for_review(.8, False).name == 'strong'
    assert r.route_for_review(.1, False).name == 'cheap'

def test_review_requires_deterministic_signal_and_majority():
    f = Finding(job_id='j', title='x', category='test', confidence=.9)
    votes = [ReviewVote('a', True, .9, 'ok'), ReviewVote('b', True, .8, 'ok')]
    assert ReviewCouncil().decide(f, votes, True).verdict == Verdict.VERIFIED

def test_leaderboard_rewards_success():
    rows = leaderboard([BenchmarkResult('m','s','1',True,False,1,10,10), BenchmarkResult('m','s','2',False,True,1,10,10)])
    assert rows[0]['success_rate'] == .5
