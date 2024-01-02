import { getAssetMetadata } from "@/services/DAGApi";
import { perpDefaults } from "@/config";
import { getVPFromNormalized } from "@/utils/getVP";
import { getPriceByAssets, getReservePrice } from "@/services/PerpAPI";
import dayjs from "dayjs";

function getMajorityThreshold(aaState, stakingVars) {
  return (
    ((stakingVars.state.total_normalized_vp / 2) * aaState.s0) /
    stakingVars["perp_asset_balance_a0"]
  );
}

export function getChallengingPeriod(stakingParams) {
  return stakingParams.challenging_period || 432000;
}

function getPriceAAsMetaFromVars(aaState, stakingParams, stakingVars) {
  const priceAAsMeta = {
    finished: {},
    notFinished: {},
    allPriceAAs: [],
  };

  Object.keys(stakingVars).forEach((key) => {
    if (key.startsWith("leader_add_price_aa")) {
      const priceAA = key.substring("leader_add_price_aa".length);
      const finished = !!stakingVars[`add_price_aa${priceAA}`];
      const result = stakingVars[`add_price_aa${priceAA}`] || null;
      const leaderAddPriceAA = stakingVars[`leader_add_price_aa${priceAA}`];
      const vpAddPrice =
        stakingVars[
          `value_votes_add_price_aa${priceAA}_${leaderAddPriceAA.value}`
        ] || null;

      // $new_leader_vp > $get_majority_threshold() OR timestamp > $leader.flip_ts + $challenging_period
      const vpAddPriceBCommit = stakingVars[
        `value_votes_add_price_aa${priceAA}_${leaderAddPriceAA.value}`
      ]
        ? vpAddPrice > getMajorityThreshold(aaState, stakingVars) ||
          Math.floor(Date.now() / 1000) >
            leaderAddPriceAA.flip_ts + getChallengingPeriod(stakingParams)
        : null;

      const finishDate = finished
        ? null
        : dayjs(
            (leaderAddPriceAA.flip_ts + getChallengingPeriod(stakingParams)) *
              1000
          ).format("MMMM D, YYYY HH:mm");

      priceAAsMeta[finished ? "finished" : "notFinished"][priceAA] = {
        result,
        leaderAddPriceAA,
        vpAddPrice,
        vpAddPriceBCommit,
        finishDate,
      };
      priceAAsMeta.allPriceAAs.push(priceAA);
    }
  });

  return priceAAsMeta;
}

const cacheForPreparedMetaByAsset0AndReserve = {};
export async function getPreparedMeta(
  metaByAA,
  userAddress = "_",
  force = false
) {
  const key = `${metaByAA.state.asset0}_${metaByAA.reserve_asset}_${userAddress}`;
  if (!force && cacheForPreparedMetaByAsset0AndReserve[key]) {
    return cacheForPreparedMetaByAsset0AndReserve[key];
  }

  const priceAAsMeta = getPriceAAsMetaFromVars(
    metaByAA.state,
    metaByAA.stakingParams,
    metaByAA.stakingVars
  );

  const vp = userAddress
    ? metaByAA.stakingVars[`user_${userAddress}_a0`]?.normalized_vp || 0
    : 0;

  const asset0SymbolAndDecimals = await getAssetMetadata(metaByAA.state.asset0);
  let stakeBalance = userAddress
    ? metaByAA.stakingVars[`user_${userAddress}_a0`]?.balance || 0
    : 0;

  if (stakeBalance) {
    stakeBalance = stakeBalance / 10 ** asset0SymbolAndDecimals.decimals;
  }

  const reserveAsset = await getAssetMetadata(metaByAA.reserve_asset);

  const reservePriceAA = metaByAA.reserve_price_aa;
  const reservePrice = await getReservePrice(reservePriceAA);
  const reservePriceValue = reservePrice * 10 ** (reserveAsset?.decimals || 0);

  const reserve = metaByAA.state.reserve / 10 ** reserveAsset.decimals;
  const reserveInUsd = reserve * reservePriceValue;
  const totalStakeBalance = metaByAA.stakingVars["perp_asset_balance_a0"];
  const price = await getPriceByAssets(
    metaByAA.aa,
    [metaByAA.state.asset0],
    metaByAA
  );
  const stakeInUsd = price[metaByAA.state.asset0] * reservePrice;

  const meta = {
    asset0SymbolAndDecimals,
    priceAAsMeta,
    reserveAsset,
    rawMeta: metaByAA,
    vp,
    allowedControl: vp > 0,
    stakeBalance,
    reservePriceAA,
    reservePriceValue,
    reserve,
    reserveInUsd,
    totalStakeBalance,
    stakeInUsd,
  };
  cacheForPreparedMetaByAsset0AndReserve[key] = meta;

  return meta;
}

export function getParam(name, meta) {
  if (meta[name]) {
    return meta[name];
  }

  return perpDefaults[name] || "none";
}

function sortVotes(votes) {
  Object.keys(votes).forEach((k) => {
    if (!Array.isArray(votes[k])) {
      sortVotes(votes[k]);
      return;
    }

    votes[k].sort((a, b) => b.amount - a.amount);
  });
}
export function getAllVotes(vars, timestamp, decayFactor) {
  const votes = {
    add_price_aa: {},
    change_price_aa: {},
    change_drift_rate: {},
  };

  Object.keys(vars).forEach((k) => {
    if (k.startsWith("value_votes_")) {
      let v = k.substring(12).split("_"); // deleting value_votes_
      let value = v.pop();
      let key = v.join("_");
      const amount = getVPFromNormalized(vars[k], decayFactor, timestamp);

      if (Object.keys(perpDefaults).includes(key)) {
        if (!votes[key]) votes[key] = [];
        votes[key].push({ value: value, amount });
      } else {
        let length = 0;
        let type = "";
        if (key.startsWith("add_price_aa")) {
          type = "add_price_aa";
          length = 12;
        } else if (key.startsWith("change_price_aa")) {
          type = "change_price_aa";
          length = 15;
        } else if (key.startsWith("change_drift_rate")) {
          type = "change_drift_rate";
          length = 17;
        } else {
          return; // not supported
        }

        key = key.substring(length);
        if (!votes[type][key]) votes[type][key] = [];

        votes[type][key].push({ value, amount });
      }
    }
  });

  sortVotes(votes);
  return votes;
}
