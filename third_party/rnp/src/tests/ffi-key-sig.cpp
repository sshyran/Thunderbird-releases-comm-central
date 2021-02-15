/*
 * Copyright (c) 2020 [Ribose Inc](https://www.ribose.com).
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1.  Redistributions of source code must retain the above copyright notice,
 *     this list of conditions and the following disclaimer.
 *
 * 2.  Redistributions in binary form must reproduce the above copyright notice,
 *     this list of conditions and the following disclaimer in the documentation
 *     and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#include <rnp/rnp.h>
#include "rnp_tests.h"
#include "support.h"

TEST_F(rnp_tests, test_ffi_key_signatures)
{
    rnp_ffi_t   ffi = NULL;
    rnp_input_t input = NULL;

    assert_rnp_success(rnp_ffi_create(&ffi, "GPG", "GPG"));
    // load key
    assert_rnp_success(
      rnp_input_from_path(&input, "data/test_stream_key_load/ecc-p384-pub.asc"));
    assert_rnp_success(rnp_load_keys(ffi, "GPG", input, RNP_LOAD_SAVE_PUBLIC_KEYS));
    rnp_input_destroy(input);
    // check primary key
    rnp_key_handle_t key = NULL;
    assert_rnp_success(rnp_locate_key(ffi, "keyid", "242A3AA5EA85F44A", &key));
    // some edge cases
    size_t                 sigs = 0;
    rnp_signature_handle_t sig = NULL;
    assert_rnp_failure(rnp_key_get_signature_count(NULL, &sigs));
    assert_rnp_failure(rnp_key_get_signature_count(key, NULL));
    assert_rnp_failure(rnp_key_get_signature_at(key, 0, &sig));
    assert_rnp_failure(rnp_key_get_signature_at(key, 0x10000, &sig));
    assert_rnp_failure(rnp_key_get_signature_at(NULL, 0x10000, &sig));
    assert_rnp_failure(rnp_key_get_signature_at(NULL, 0, NULL));
    // key doesn't have signatures
    assert_rnp_success(rnp_key_get_signature_count(key, &sigs));
    assert_int_equal(sigs, 0);
    // uid must have one signature
    rnp_uid_handle_t uid = NULL;
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    assert_rnp_success(rnp_uid_get_signature_count(uid, &sigs));
    assert_int_equal(sigs, 1);
    assert_rnp_failure(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    char *type = NULL;
    assert_rnp_failure(rnp_signature_get_type(NULL, &type));
    assert_rnp_failure(rnp_signature_get_type(sig, NULL));
    assert_rnp_success(rnp_signature_get_type(sig, &type));
    assert_string_equal(type, "certification (positive)");
    rnp_buffer_destroy(type);
    uint32_t creation = 0;
    assert_rnp_success(rnp_signature_get_creation(sig, &creation));
    assert_int_equal(creation, 1549119505);
    char *alg = NULL;
    assert_rnp_failure(rnp_signature_get_alg(NULL, &alg));
    assert_rnp_failure(rnp_signature_get_alg(sig, NULL));
    assert_rnp_success(rnp_signature_get_alg(sig, &alg));
    assert_string_equal(alg, "ECDSA");
    rnp_buffer_destroy(alg);
    assert_rnp_success(rnp_signature_get_hash_alg(sig, &alg));
    assert_string_equal(alg, "SHA384");
    rnp_buffer_destroy(alg);
    char *keyid = NULL;
    assert_rnp_success(rnp_signature_get_keyid(sig, &keyid));
    assert_non_null(keyid);
    assert_string_equal(keyid, "242A3AA5EA85F44A");
    rnp_buffer_destroy(keyid);
    rnp_key_handle_t signer = NULL;
    assert_rnp_success(rnp_signature_get_signer(sig, &signer));
    assert_non_null(signer);
    assert_rnp_success(rnp_key_get_keyid(signer, &keyid));
    assert_non_null(keyid);
    assert_string_equal(keyid, "242A3AA5EA85F44A");
    rnp_buffer_destroy(keyid);
    rnp_key_handle_destroy(signer);
    assert_int_equal(rnp_signature_is_valid(NULL, 0), RNP_ERROR_NULL_POINTER);
    assert_int_equal(rnp_signature_is_valid(sig, 17), RNP_ERROR_BAD_PARAMETERS);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    assert_rnp_success(rnp_signature_handle_destroy(sig));
    // subkey must have one signature
    rnp_key_handle_t subkey = NULL;
    assert_rnp_success(rnp_key_get_subkey_at(key, 0, &subkey));
    assert_rnp_success(rnp_key_get_signature_count(subkey, &sigs));
    assert_int_equal(sigs, 1);
    assert_rnp_success(rnp_key_get_signature_at(subkey, 0, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &type));
    assert_string_equal(type, "subkey binding");
    rnp_buffer_destroy(type);
    assert_rnp_success(rnp_signature_get_creation(sig, &creation));
    assert_int_equal(creation, 1549119513);
    assert_rnp_success(rnp_signature_get_alg(sig, &alg));
    assert_string_equal(alg, "ECDSA");
    rnp_buffer_destroy(alg);
    assert_rnp_success(rnp_signature_get_hash_alg(sig, &alg));
    assert_string_equal(alg, "SHA384");
    rnp_buffer_destroy(alg);
    assert_rnp_success(rnp_signature_get_keyid(sig, &keyid));
    assert_non_null(keyid);
    assert_string_equal(keyid, "242A3AA5EA85F44A");
    rnp_buffer_destroy(keyid);
    assert_rnp_success(rnp_signature_get_signer(sig, &signer));
    assert_non_null(signer);
    assert_rnp_success(rnp_key_get_keyid(signer, &keyid));
    assert_non_null(keyid);
    assert_string_equal(keyid, "242A3AA5EA85F44A");
    rnp_buffer_destroy(keyid);
    rnp_key_handle_destroy(signer);
    rnp_key_handle_destroy(subkey);
    assert_rnp_success(rnp_signature_handle_destroy(sig));
    assert_rnp_success(rnp_uid_handle_destroy(uid));
    assert_rnp_success(rnp_key_handle_destroy(key));

    // cleanup
    rnp_ffi_destroy(ffi);
}

static bool
check_import_sigs(rnp_ffi_t ffi, json_object **jso, json_object **sigarr, const char *sigpath)
{
    rnp_input_t input = NULL;
    if (rnp_input_from_path(&input, sigpath)) {
        return false;
    }
    bool  res = false;
    char *sigs = NULL;
    *jso = NULL;

    if (rnp_import_signatures(ffi, input, 0, &sigs)) {
        goto done;
    }
    if (!sigs) {
        goto done;
    }

    *jso = json_tokener_parse(sigs);
    if (!jso) {
        goto done;
    }
    if (!json_object_is_type(*jso, json_type_object)) {
        goto done;
    }
    if (!json_object_object_get_ex(*jso, "sigs", sigarr)) {
        goto done;
    }
    if (!json_object_is_type(*sigarr, json_type_array)) {
        goto done;
    }
    res = true;
done:
    if (!res) {
        json_object_put(*jso);
        *jso = NULL;
    }
    rnp_input_destroy(input);
    rnp_buffer_destroy(sigs);
    return res;
}

static bool
check_sig_status(json_object *sig, const char *pub, const char *sec, const char *fp)
{
    if (!sig) {
        return false;
    }
    if (!json_object_is_type(sig, json_type_object)) {
        return false;
    }
    json_object *fld = NULL;
    if (!json_object_object_get_ex(sig, "public", &fld)) {
        return false;
    }
    if (strcmp(json_object_get_string(fld), pub) != 0) {
        return false;
    }
    if (!json_object_object_get_ex(sig, "secret", &fld)) {
        return false;
    }
    if (strcmp(json_object_get_string(fld), sec) != 0) {
        return false;
    }
    if (!fp && json_object_object_get_ex(sig, "signer fingerprint", &fld)) {
        return false;
    }
    if (fp) {
        if (!json_object_object_get_ex(sig, "signer fingerprint", &fld)) {
            return false;
        }
        if (strcmp(json_object_get_string(fld), fp) != 0) {
            return false;
        }
    }
    return true;
}

TEST_F(rnp_tests, test_ffi_import_signatures)
{
    rnp_ffi_t   ffi = NULL;
    rnp_input_t input = NULL;
    char *      results = NULL;

    assert_rnp_success(rnp_ffi_create(&ffi, "GPG", "GPG"));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, &results));
    assert_rnp_success(rnp_input_destroy(input));
    rnp_buffer_destroy(results);
    /* find key and check signature count */
    rnp_key_handle_t key_handle = NULL;
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    size_t sigcount = 0;
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 0);
    /* check revocation status */
    bool revoked = false;
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_false(revoked);
    /* some import edge cases */
    assert_rnp_failure(rnp_import_signatures(ffi, NULL, 0, &results));
    assert_rnp_failure(rnp_import_signatures(NULL, input, 0, &results));
    assert_rnp_failure(rnp_import_signatures(ffi, input, 0x18, &results));
    /* import revocation signature */
    json_object *jso = NULL;
    json_object *jsosigs = NULL;
    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-rev.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 1);
    json_object *jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(check_sig_status(
      jsosig, "new", "unknown key", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);
    /* key now must become revoked */
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_true(revoked);
    /* check signature number - it now must be 1 */
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 1);
    /* check signature type */
    rnp_signature_handle_t sig = NULL;
    assert_rnp_success(rnp_key_get_signature_at(key_handle, 0, &sig));
    char *type = NULL;
    assert_rnp_success(rnp_signature_get_type(sig, &type));
    assert_string_equal(type, "key revocation");
    rnp_buffer_destroy(type);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    uint32_t screate = 0;
    assert_rnp_success(rnp_signature_get_creation(sig, &screate));
    assert_int_equal(screate, 1578663151);
    rnp_signature_handle_destroy(sig);
    /* check key validity */
    bool valid = true;
    assert_rnp_success(rnp_key_is_valid(key_handle, &valid));
    assert_false(valid);
    uint32_t till = 0;
    assert_rnp_success(rnp_key_valid_till(key_handle, &till));
    assert_int_equal(till, 1578663151);
    /* check import with NULL results param */
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-rev.pgp"));
    assert_rnp_success(rnp_import_signatures(ffi, input, 0, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* import signature again, making sure it is not duplicated */
    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-rev.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 1);
    jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(check_sig_status(
      jsosig, "unchanged", "unknown key", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);
    /* check signature count, using the same key handle (it must not be changed) */
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 1);
    rnp_key_handle_destroy(key_handle);

    /* save and reload keyring, making sure signature is saved */
    rnp_output_t output = NULL;
    assert_rnp_success(rnp_output_to_path(&output, "pubring.gpg"));
    assert_rnp_success(rnp_save_keys(ffi, "GPG", output, RNP_LOAD_SAVE_PUBLIC_KEYS));
    assert_rnp_success(rnp_output_destroy(output));
    assert_rnp_success(rnp_ffi_destroy(ffi));
    /* re-init ffi and load keys */
    assert_rnp_success(rnp_ffi_create(&ffi, "GPG", "GPG"));
    assert_rnp_success(rnp_input_from_path(&input, "pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* find key and check sig count and revocation status */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 1);
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_true(revoked);
    assert_rnp_success(rnp_key_is_valid(key_handle, &valid));
    assert_false(valid);
    assert_rnp_success(rnp_key_valid_till(key_handle, &till));
    assert_int_equal(till, 1578663151);
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    assert_int_equal(unlink("pubring.gpg"), 0);

    /* try to import wrong signature (certification) */
    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-cert.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 1);
    jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(check_sig_status(jsosig, "none", "none", NULL));
    json_object_put(jso);

    /* try to import signature for both public and secret key */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC | RNP_KEY_UNLOAD_SECRET));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-sec.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_SECRET_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-rev.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 1);
    jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(
      check_sig_status(jsosig, "new", "new", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);

    /* import direct-key signature (with revocation key subpacket) */
    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-revoker-sig.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 1);
    jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(
      check_sig_status(jsosig, "new", "new", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 2);
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_true(revoked);
    assert_rnp_success(rnp_key_get_signature_at(key_handle, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &type));
    assert_string_equal(type, "direct");
    rnp_buffer_destroy(type);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    assert_rnp_success(rnp_key_handle_destroy(key_handle));

    /* load two binary signatures from the file */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC | RNP_KEY_UNLOAD_SECRET));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-sigs.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 2);
    jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(check_sig_status(
      jsosig, "new", "unknown key", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    jsosig = json_object_array_get_idx(jsosigs, 1);
    assert_true(check_sig_status(
      jsosig, "new", "unknown key", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 2);
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_true(revoked);
    assert_rnp_success(rnp_key_handle_destroy(key_handle));

    /* load two armored signatures from the single file */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC | RNP_KEY_UNLOAD_SECRET));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-sec.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_SECRET_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    assert_true(
      check_import_sigs(ffi, &jso, &jsosigs, "data/test_key_validity/alice-sigs.asc"));
    assert_int_equal(json_object_array_length(jsosigs), 2);
    jsosig = json_object_array_get_idx(jsosigs, 0);
    /* when secret key is loaded then public copy is created automatically */
    assert_true(
      check_sig_status(jsosig, "new", "new", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    jsosig = json_object_array_get_idx(jsosigs, 1);
    assert_true(
      check_sig_status(jsosig, "new", "new", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 2);
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_true(revoked);
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    /* try to import signature from key file - must fail */
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-sec.asc"));
    results = NULL;
    assert_rnp_failure(rnp_import_signatures(ffi, input, 0, &results));
    assert_null(results);
    assert_rnp_success(rnp_input_destroy(input));
    /* try to import signatures from stream where second is malformed. Nothing should be
     * imported. */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC | RNP_KEY_UNLOAD_SECRET));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(
      rnp_input_from_path(&input, "data/test_key_validity/alice-sigs-malf.pgp"));
    results = NULL;
    assert_rnp_failure(rnp_import_signatures(ffi, input, 0, &results));
    assert_null(results);
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 0);
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_false(revoked);
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    assert_rnp_success(rnp_ffi_destroy(ffi));
}

TEST_F(rnp_tests, test_ffi_export_revocation)
{
    rnp_ffi_t   ffi = NULL;
    rnp_input_t input = NULL;

    assert_rnp_success(rnp_ffi_create(&ffi, "GPG", "GPG"));
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-sec.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_SECRET_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    rnp_key_handle_t key_handle = NULL;
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    rnp_output_t output = NULL;
    assert_rnp_success(rnp_output_to_null(&output));
    /* check for failure with wrong parameters */
    assert_rnp_failure(rnp_key_export_revocation(
      NULL, output, 0, "SHA256", "superseded", "test key revocation"));
    assert_rnp_failure(rnp_key_export_revocation(key_handle, NULL, 0, "SHA256", NULL, NULL));
    assert_rnp_failure(
      rnp_key_export_revocation(key_handle, output, 0x17, "SHA256", NULL, NULL));
    assert_rnp_failure(
      rnp_key_export_revocation(key_handle, output, 0, "Wrong hash", NULL, NULL));
    assert_rnp_failure(
      rnp_key_export_revocation(key_handle, output, 0, "SHA256", "Wrong reason code", NULL));
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    /* check for failure with subkey */
    assert_rnp_success(
      rnp_input_from_path(&input, "data/test_key_validity/alice-sub-sec.pgp"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_SECRET_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(rnp_locate_key(ffi, "keyid", "DD23CEB7FEBEFF17", &key_handle));
    assert_rnp_success(rnp_key_unlock(key_handle, "password"));
    assert_rnp_failure(rnp_key_export_revocation(
      key_handle, output, 0, "SHA256", "superseded", "test key revocation"));
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    /* try to export revocation having public key only */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_SECRET));
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    assert_rnp_failure(rnp_key_export_revocation(
      key_handle, output, 0, "SHA256", "superseded", "test key revocation"));
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    /* load secret key and export revocation - should succeed with correct password */
    assert_rnp_success(rnp_input_from_path(&input, "data/test_key_validity/alice-sec.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_SECRET_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    /* wrong password - must fail */
    assert_rnp_success(
      rnp_ffi_set_pass_provider(ffi, ffi_string_password_provider, (void *) "wrong"));
    assert_rnp_failure(rnp_key_export_revocation(
      key_handle, output, 0, "SHA256", "superseded", "test key revocation"));
    /* unlocked key - must succeed */
    assert_rnp_success(rnp_key_unlock(key_handle, "password"));
    assert_rnp_success(rnp_key_export_revocation(key_handle, output, 0, "SHA256", NULL, NULL));
    assert_rnp_success(rnp_output_destroy(output));
    assert_rnp_success(rnp_output_to_path(&output, "alice-revocation.pgp"));
    /* correct password provider - must succeed */
    assert_rnp_success(rnp_key_lock(key_handle));
    assert_rnp_success(
      rnp_ffi_set_pass_provider(ffi, ffi_string_password_provider, (void *) "password"));
    assert_rnp_success(rnp_key_export_revocation(
      key_handle, output, 0, "SHA256", "superseded", "test key revocation"));
    /* make sure FFI locks key back */
    bool locked = false;
    assert_rnp_success(rnp_key_is_locked(key_handle, &locked));
    assert_true(locked);
    assert_rnp_success(rnp_output_destroy(output));
    assert_rnp_success(rnp_key_handle_destroy(key_handle));
    /* make sure we can successfully import exported revocation */
    json_object *jso = NULL;
    json_object *jsosigs = NULL;
    assert_true(check_import_sigs(ffi, &jso, &jsosigs, "alice-revocation.pgp"));
    assert_int_equal(json_object_array_length(jsosigs), 1);
    json_object *jsosig = json_object_array_get_idx(jsosigs, 0);
    assert_true(
      check_sig_status(jsosig, "new", "new", "73edcc9119afc8e2dbbdcde50451409669ffde3c"));
    json_object_put(jso);
    /* key now must become revoked */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key_handle));
    bool revoked = false;
    assert_rnp_success(rnp_key_is_revoked(key_handle, &revoked));
    assert_true(revoked);
    /* check signature number - it now must be 1 */
    size_t sigcount = 0;
    assert_rnp_success(rnp_key_get_signature_count(key_handle, &sigcount));
    assert_int_equal(sigcount, 1);
    assert_rnp_success(rnp_key_handle_destroy(key_handle));

    /* check signature contents */
    pgp_source_t src = {};
    assert_rnp_success(init_file_src(&src, "alice-revocation.pgp"));
    pgp_signature_t sig = {};
    assert_rnp_success(sig.parse(src));
    src_close(&src);
    assert_int_equal(sig.type(), PGP_SIG_REV_KEY);
    assert_true(sig.has_subpkt(PGP_SIG_SUBPKT_REVOCATION_REASON));
    assert_true(sig.has_keyfp());
    assert_int_equal(sig.revocation_code(), PGP_REVOCATION_SUPERSEDED);
    assert_string_equal(sig.revocation_reason().c_str(), "test key revocation");
    assert_int_equal(unlink("alice-revocation.pgp"), 0);

    assert_rnp_success(rnp_ffi_destroy(ffi));
}

#define KEYSIG_PATH "data/test_key_validity/"

TEST_F(rnp_tests, test_ffi_sig_validity)
{
    rnp_ffi_t ffi = NULL;
    assert_rnp_success(rnp_ffi_create(&ffi, "GPG", "GPG"));

    /* Case1:
     * Keys: Alice [pub]
     * Alice is signed by Basil, but without the Basil's key.
     * Result: Alice [valid]
     */
    rnp_input_t input = NULL;
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case1/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    rnp_key_handle_t key = NULL;
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    rnp_uid_handle_t uid = NULL;
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    bool valid = false;
    assert_rnp_success(rnp_uid_is_valid(uid, &valid));
    assert_true(valid);
    rnp_signature_handle_t sig = NULL;
    /* signature 0: valid self-signature */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    char *sigtype = NULL;
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* signature 1: valid certification from Basil, but without Basil's key */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (generic)");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_KEY_NOT_FOUND);
    /* let's load Basil's key and make sure signature is now validated and valid */
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "basil-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);

    /* Case2:
     * Keys: Alice [pub], Basil [pub]
     * Alice is signed by Basil, Basil is signed by Alice, but Alice's self-signature is
     * corrupted.
     * Result: Alice [invalid], Basil [valid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case2/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* Alice key */
    /* we cannot get key by uid since uid is invalid */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    assert_null(key);
    /* get it via the fingerprint */
    assert_rnp_success(
      rnp_locate_key(ffi, "fingerprint", "73EDCC9119AFC8E2DBBDCDE50451409669FFDE3C", &key));
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    assert_rnp_success(rnp_uid_is_valid(uid, &valid));
    assert_false(valid);
    /* signature 0: corrupted self-signature */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_INVALID);
    rnp_signature_handle_destroy(sig);
    /* signature 1: valid certification from Basil */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (generic)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);
    /* Basil key */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Basil <basil@rnp>", &key));
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    assert_rnp_success(rnp_uid_is_valid(uid, &valid));
    assert_true(valid);
    /* signature 0: valid self-signature */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* signature 1: valid certification from Alice */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (generic)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);

    /* Case3:
     * Keys: Alice [pub], Basil [pub]
     * Alice is signed by Basil, but doesn't have self-signature
     * Result: Alice [invalid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case3/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* Alice key */
    /* cannot locate it via userid since it is invalid */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    assert_null(key);
    /* let's locate it via the fingerprint */
    assert_rnp_success(
      rnp_locate_key(ffi, "fingerprint", "73EDCC9119AFC8E2DBBDCDE50451409669FFDE3C", &key));
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    assert_rnp_success(rnp_uid_is_valid(uid, &valid));
    assert_false(valid);
    /* signature 0: valid certification from Basil */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (generic)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);

    /* Case4:
     * Keys Alice [pub, sub]
     * Alice subkey has invalid binding signature
     * Result: Alice [valid], Alice sub [invalid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case4/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    rnp_key_handle_t sub = NULL;
    rnp_key_get_subkey_at(key, 0, &sub);
    rnp_key_get_signature_at(sub, 0, &sig);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_INVALID);
    rnp_signature_handle_destroy(sig);
    rnp_key_handle_destroy(sub);
    rnp_key_handle_destroy(key);

    /* Case5:
     * Keys Alice [pub, sub], Basil [pub]
     * Alice subkey has valid binding signature, but from the key Basil
     * Result: Alice [valid], Alice sub [invalid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case5/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    rnp_key_get_subkey_at(key, 0, &sub);
    rnp_key_get_signature_at(sub, 0, &sig);
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "subkey binding");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_INVALID);
    rnp_signature_handle_destroy(sig);
    rnp_key_handle_destroy(sub);
    rnp_key_handle_destroy(key);

    /* Case6:
     * Keys Alice [pub, sub]
     * Key Alice has revocation signature by Alice, and subkey doesn't
     * Result: Alice [invalid], Alice sub [invalid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case6/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* check revocation signature */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    rnp_key_get_signature_at(key, 0, &sig);
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "key revocation");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* check subkey binding */
    rnp_key_get_subkey_at(key, 0, &sub);
    rnp_key_get_signature_at(sub, 0, &sig);
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "subkey binding");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_key_handle_destroy(sub);
    rnp_key_handle_destroy(key);

    /* Case7:
     * Keys Alice [pub, sub]
     * Alice subkey has revocation signature by Alice
     * Result: Alice [valid], Alice sub [invalid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case7/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* check subkey revocation signature */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    rnp_key_get_subkey_at(key, 0, &sub);
    rnp_key_get_signature_at(sub, 0, &sig);
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "subkey revocation");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* check subkey binding */
    rnp_key_get_signature_at(sub, 1, &sig);
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "subkey binding");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_key_handle_destroy(sub);
    rnp_key_handle_destroy(key);

    /* Case8:
     * Keys Alice [pub, sub]
     * Userid is stripped from the key, but it still has valid subkey binding
     * Result: Alice [valid], Alice sub[valid]
     */

    /* not interesting for us at the moment */

    /* Case9:
     * Keys Alice [pub, sub]
     * Alice key has two self-signatures, one which expires key and second without key
     * expiration.
     * Result: Alice [valid], Alice sub[valid]
     */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "case9/pubring.gpg"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    /* Alice key */
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    assert_rnp_success(rnp_uid_is_valid(uid, &valid));
    assert_true(valid);
    /* signature 0: valid certification */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* signature 1: valid certification */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);

    /* another case: expired certification */
    assert_rnp_success(rnp_unload_keys(ffi, RNP_KEY_UNLOAD_PUBLIC));
    assert_rnp_success(
      rnp_input_from_path(&input, KEYSIG_PATH "alice-expired-claus-cert.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "claus-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    assert_rnp_success(rnp_uid_is_valid(uid, &valid));
    assert_true(valid);
    /* signature 0: valid certification */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* signature 1: expired claus's certification */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (generic)");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_EXPIRED);
    rnp_signature_handle_destroy(sig);
    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);

    assert_rnp_success(rnp_ffi_destroy(ffi));
}

TEST_F(rnp_tests, test_ffi_get_signature_type)
{
    rnp_ffi_t   ffi = NULL;
    rnp_input_t input = NULL;

    assert_rnp_success(rnp_ffi_create(&ffi, "GPG", "GPG"));
    assert_rnp_success(
      rnp_input_from_path(&input, "data/test_key_edge_cases/alice-sig-misc-values.pgp"));
    assert_rnp_success(rnp_load_keys(ffi, "GPG", input, RNP_LOAD_SAVE_PUBLIC_KEYS));
    rnp_input_destroy(input);
    assert_rnp_success(rnp_input_from_path(&input, KEYSIG_PATH "basil-pub.asc"));
    assert_rnp_success(rnp_import_keys(ffi, input, RNP_LOAD_SAVE_PUBLIC_KEYS, NULL));
    assert_rnp_success(rnp_input_destroy(input));

    rnp_key_handle_t key = NULL;
    assert_rnp_success(rnp_locate_key(ffi, "userid", "Alice <alice@rnp>", &key));
    rnp_uid_handle_t uid = NULL;
    assert_rnp_success(rnp_key_get_uid_handle_at(key, 0, &uid));
    rnp_signature_handle_t sig = NULL;
    /* signature 0: valid self-signature */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 0, &sig));
    char *sigtype = NULL;
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (positive)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* signature 1: valid signature by Basil */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 1, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (generic)");
    rnp_buffer_destroy(sigtype);
    assert_rnp_success(rnp_signature_is_valid(sig, 0));
    rnp_signature_handle_destroy(sig);
    /* signature 2..7: invalid signatures with misc types */
    assert_rnp_success(rnp_uid_get_signature_at(uid, 2, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "standalone");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_VERIFICATION_FAILED);
    rnp_signature_handle_destroy(sig);
    assert_rnp_success(rnp_uid_get_signature_at(uid, 3, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (persona)");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_INVALID);
    rnp_signature_handle_destroy(sig);
    assert_rnp_success(rnp_uid_get_signature_at(uid, 4, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification (casual)");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_INVALID);
    rnp_signature_handle_destroy(sig);
    assert_rnp_success(rnp_uid_get_signature_at(uid, 5, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "primary key binding");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_VERIFICATION_FAILED);
    rnp_signature_handle_destroy(sig);
    assert_rnp_success(rnp_uid_get_signature_at(uid, 6, &sig));
    assert_rnp_success(rnp_signature_get_type(sig, &sigtype));
    assert_string_equal(sigtype, "certification revocation");
    rnp_buffer_destroy(sigtype);
    assert_int_equal(rnp_signature_is_valid(sig, 0), RNP_ERROR_SIGNATURE_INVALID);
    rnp_signature_handle_destroy(sig);

    rnp_uid_handle_destroy(uid);
    rnp_key_handle_destroy(key);

    assert_rnp_success(rnp_ffi_destroy(ffi));
}
