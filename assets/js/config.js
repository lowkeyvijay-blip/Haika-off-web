/* =========================================================================
   Haika — single source of truth for site configuration.
   Loaded before any other script. Nothing else may hardcode these values.
   ========================================================================= */
(function (root) {
  "use strict";

  var HAIKA = root.HAIKA || {};

  HAIKA.config = {

    /* ---------------------------------------------------------------------
       CONTACT
       Every contact destination on the site is rendered from this value.
       Value taken from this repository's own configuration (git author of
       the initial commit). Change it here and nowhere else.
       --------------------------------------------------------------------- */
    contact: {
      email: "Lowkey.vijay@gmail.com",
      label: "Email Haika"
    },

    /* ---------------------------------------------------------------------
       INTAKE SUBMISSION
       "" means no backend is wired up yet. Until it is, /start collects the
       brief and hands it to the visitor as a prepared email — nothing is
       silently stored or faked.

       Set this to a real endpoint (Supabase Edge Function, an API route, a
       form service) and the form switches to a real POST with server-issued
       references. Never put secrets here: this file is public.
       --------------------------------------------------------------------- */
    intake: {
      endpoint: "",
      method: "POST",
      // Header used when sending JSON. Remove it if the endpoint expects
      // a raw form body instead.
      contentType: "application/json",
      // Optional shared secret read from a same-origin meta tag so the
      // endpoint can reject stray traffic without exposing a key in JS.
      authMeta: "haika-intake-token"
    },

    /* Reference IDs are issued by the server when an endpoint is set.
       Locally we only mint a DRAFT reference, which is labelled as such. */
    reference: {
      prefix: "HK"
    },

    /* The hero clip. Posters are local; the clip itself is remote. */
    hero: {
      video: "https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/45567745-d826-44a2-a5ce-7ef670944e60.mp4",
      poster: "assets/hero-poster.jpg"
    }
  };

  root.HAIKA = HAIKA;
})(window);
