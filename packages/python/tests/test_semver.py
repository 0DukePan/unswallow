import unittest

from unswallow.semver import matches_range, parse_version


class SemverTest(unittest.TestCase):
    def test_parse_version(self):
        self.assertEqual(parse_version("0.19.0"), [0, 19, 0])
        self.assertEqual(parse_version("1.2"), [1, 2, 0])
        self.assertEqual(parse_version("v3"), [3, 0, 0])
        self.assertIsNone(parse_version("garbage"))

    def test_lte(self):
        self.assertTrue(matches_range("0.19.0", "<=0.19.0"))
        self.assertTrue(matches_range("0.18.9", "<=0.19.0"))
        self.assertFalse(matches_range("0.20.0", "<=0.19.0"))

    def test_gte(self):
        self.assertTrue(matches_range("0.24.0", ">=0.24.0"))
        self.assertTrue(matches_range("0.26.0", ">=0.24.0"))
        self.assertFalse(matches_range("0.23.9", ">=0.24.0"))

    def test_anded(self):
        self.assertTrue(matches_range("0.23.4", ">=0.20.0 <0.24.0"))
        self.assertTrue(matches_range("0.20.0", ">=0.20.0 <0.24.0"))
        self.assertFalse(matches_range("0.19.9", ">=0.20.0 <0.24.0"))
        self.assertFalse(matches_range("0.24.0", ">=0.20.0 <0.24.0"))

    def test_wildcard_and_or(self):
        self.assertTrue(matches_range("0.24.0", "*"))
        self.assertTrue(matches_range("0.24.0", "<0.20.0 || >=0.24.0"))
        self.assertFalse(matches_range("0.22.0", "<0.20.0 || >=0.24.0"))

    def test_exact(self):
        self.assertTrue(matches_range("0.19.0", "0.19.0"))
        self.assertFalse(matches_range("0.19.1", "0.19.0"))

    def test_invalid(self):
        self.assertFalse(matches_range("not-a-version", "*"))
        self.assertFalse(matches_range("0.19.0", "not-a-range"))
        self.assertFalse(matches_range("", "*"))

    def test_build_tags(self):
        self.assertTrue(matches_range("b8461", "*"))
        self.assertFalse(matches_range("b8461", ">=10000.0.0"))


if __name__ == "__main__":
    unittest.main()