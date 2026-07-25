'use strict';
// THE CHECKOUT, IN ONE PLACE.
//
// `buy` shipped printing "there is no checkout page yet" — a sentence a stranger reads on the
// way to closing the tab. The honest email rail works and it will stay as the fallback, but it
// converts like a favour with a form on it, because that is what it is: nobody composes an
// email to hand over thirty-nine dollars.
//
// So the URL lives here, alone, and the day a payment link exists it is a one-line change and
// every surface picks it up at once — buy, doctor's close, the README generator. Nothing else
// in the codebase should ever hardcode a payment address.
//
// Env override exists so a link can be tested end-to-end before it is committed:
//   CLAUDE_SPINE_PAY_URL=https://... claude-spine buy

const LINKS = {
  // monthly: 'https://buy.stripe.com/...',
  // annual:  'https://buy.stripe.com/...',
};

function payUrl(term = 'monthly') {
  const env = process.env.CLAUDE_SPINE_PAY_URL;
  if (env) return env;
  return LINKS[term] || LINKS.monthly || null;
}

function hasCheckout() {
  return Boolean(payUrl('monthly') || payUrl('annual'));
}

module.exports = { payUrl, hasCheckout };
