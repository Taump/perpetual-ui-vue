import Decimal from "decimal.js";

export function calcVoteValue(value, type) {
  if (type === "date") {
    return new Decimal(value).div(24).div(3600).toNumber();
  } else if (type === "percent") {
    return new Decimal(value).times(100).toNumber();
  } else {
    return value;
  }
}
