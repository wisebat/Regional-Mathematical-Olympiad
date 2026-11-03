/* Client-side format and date checks for the local test page. */
(function (root) {
  "use strict";
  function normalizeId(value) { return String(value || "").trim().toUpperCase(); }
  function parseDateOfBirth(value) {
  const raw = String(value || "").trim();

  // Supports the calendar value and the previous DD/MM/YYYY format.
  const iso = raw.replace(
    /^(\d{2})\/(\d{2})\/(\d{4})$/,
    "$3-$2-$1"
  );

  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { error: "Please select your date of birth." };
  }

  const date = new Date(`${iso}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso
  ) {
    return { error: "Please enter a valid date of birth." };
  }

  if (iso < "2007-08-01" || iso > "2014-07-31") {
    return {
      error: "Your date of birth must be between 1 August 2007 and 31 July 2014."
    };
  }

  return { iso };
}
  function validate(erpId, dob) {
    const id = normalizeId(erpId);
    const date = parseDateOfBirth(dob);
    return {
      erpId: id,
      dateOfBirth: date.iso,
      idError: /^MTA26\d{6}$/.test(id) ? "" : "Enter a valid MTA ID",
      dobError: date.error || "",
    };
  }
  root.EPRSValidation = { normalizeId, parseDateOfBirth, validate };
})(globalThis);
