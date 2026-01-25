import fetch from "node-fetch";
import "dotenv/config";

const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;

const leagueIds = [
  2,45,40,47,39,66,61,78,81,137,135,94,96,97,71,
  475,624,629,477,13,11,88,90,180,182,3,848,204,203
];

async function getLeague(id) {
  const res = await fetch(`https://v3.football.api-sports.io/leagues?id=${id}`, {
    headers: { "x-apisports-key": API_KEY }
  });
  const json = await res.json();
  const l = json.response?.[0];
  if (!l) return null;

  return {
    id,
    name: l.league.name,
    country: l.country?.name,
    type: l.league.type
  };
}

(async () => {
  const result = [];
  for (const id of leagueIds) {
    const r = await getLeague(id);
    result.push(r);
    console.log(r);
  }

  console.log("\nJSON FINAL:");
  console.log(JSON.stringify(result, null, 2));
})();
