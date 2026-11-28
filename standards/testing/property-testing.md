# Property-based tests (C# / FsCheck)

This is the shape to write when a contract states a law. It is written for an
engineer who has used `[Fact]` and `[Theory]` and is new to generated inputs.
The worked example is a round-trip law, and the rules it applies are in
[`test-review.md`](test-review.md). The snippets use FsCheck 3's Fluent API:
add the `FsCheck` package and `FsCheck.Xunit` (or `FsCheck.Xunit.v3` on xUnit
v3; xUnit v3 is the house shape).

> One law per method; the generated input is a typed parameter; the shared law
> body, the generator, the seed and the canary sit beside the law, never inside
> it; a named example stays beside it in its own file. The rest of this page
> says why.

## Why a property test

An example test says: for this input, this output. A table says: for these N
inputs, these outputs. A property says: for every input the contract allows,
this relationship holds.

That buys two things:

- **the long tail** — generated inputs reach combinations nobody typed into a
  table;
- **the smallest counterexample** — when one fails, the framework shrinks the
  input to the simplest case that still fails, which is usually the boundary
  the contract cares about.

It costs one thing: a property is only as good as its generator. A property
over inputs the contract never promised proves nothing, and a law copied from
the implementation proves only that the implementation agrees with itself. The
law and the generator come from the documented contract, not from the code
under test.

## What FsCheck does

`[Property]` is FsCheck's test attribute. When the test runner sees it:

1. it reads the method's parameters and generates a value for each one;
2. it calls the method once per generated case (100 cases by default), plus
   shrinking attempts when one fails;
3. an assertion failure ends the run, and FsCheck shrinks the input to the
   smallest failing case;
4. the failure prints the shrunk case and the replay seed, so the run can be
   repeated exactly.

The generated parameter is the arrangement. That is why the readable test has
no `// Arrange` block: there is no setup for the reader to follow.

## The shape that is hard to read

This is the shape generated tests often arrive in. It is not wrong because it
uses FsCheck; it is hard because five ideas are tangled in one method:

```csharp
[Property(Replay = "20261122,1")]
public Property CustomerXml_Works()
{
    return Prop.ForAll(
        Arb.From(Gen.Elements(
            new Customer(1, "Ada"),
            new Customer(2, "Grace"))),
        customer => CustomerXml.Parse(CustomerXml.Render(customer)).Name ==
            customer.Name && customer.Id > 0);
}
```

- the name says nothing about the law;
- the generated input type is buried in a lambda;
- the generator is built inside the test, so the domain is invisible;
- two claims share one `&&`, so the failure cannot say which one broke;
- the seed is a literal, so the world never rotates and the reader cannot tell
  whether it matters.

## The law

Read the shape below as a sentence: for any valid customer, rendering and then
parsing returns the original customer. The law body is a bool predicate that
takes the operation, so the property, the canary and the seed ledger replay all
call the same code.

The class declares the family and opens with its docblock; the law and the
shared body sit inside it:

```csharp
using FsCheck.Xunit;
using Shouldly;

/// <summary>
/// The customer XML round-trip family (AB#1234). The named edges in
/// <see cref="CustomerXmlTests"/> keep the empty and hostile inputs; the law
/// covers the rest of the documented domain.
/// </summary>
public sealed class CustomerXmlPropertyTests
{
    // the law, the shared body, the canary and the replay theory
}
```

<!-- snippet: law -->

```csharp
    /// <summary>
    /// The documented round trip: every valid customer survives render then
    /// parse unchanged.
    /// </summary>
    [Property(Arbitrary = [typeof(CustomerArbitraries)])]
    public void RenderThenParse_ForAnyValidCustomer_RestoresOriginal(Customer original)
    {
        // Act
        bool restored = RoundTrips(CustomerXml.Render, CustomerXml.Parse, original);

        // Assert
        restored.ShouldBeTrue($"render then parse must restore {original}");
    }
```

<!-- snippet: round-trips -->

```csharp
    /// <summary>
    /// The round-trip law: for any customer the pair admits, rendering and
    /// parsing returns the original.
    /// </summary>
    private static bool RoundTrips(
        Func<Customer, string> render,
        Func<string, Customer> parse,
        Customer original) =>
        parse(render(original)) == original;
```

Every part earns its place:

- `RenderThenParse_ForAnyValidCustomer_RestoresOriginal` names the operation,
  the domain and the law. A failure in CI names the contract before anyone
  opens the file.
- `Customer original` is the generated input, with its type visible. The reader
  does not have to infer the domain from a lambda.
- The law body takes the operation as a function. The property passes the real
  pair; the canary passes a mutant; the ledger replay passes the real pair
  again. One body, three callers, no drift. A service whose call cannot be
  substituted uses the output as the seam instead: the body takes the value the
  law asserts over, the property passes the real service's result, and the
  canary passes a corrupted copy.
- The property's `Act` is one call. The two production calls are one behaviour
  inside the law body: a round trip is an operation with two halves. Splitting
  them into `Arrange` would hide that the render is part of what is tested.
- `ShouldBeTrue` carries a message naming the counterexample, because a bool
  body does not print both values the way a `ShouldBe` diff does. The canary is
  what names the clause that broke.
- There is no seed, generator or `Prop.ForAll` in the body. Those are
  infrastructure; the law is the only thing the reader should have to hold in
  their head.

The example spells out its types for the reader. That is deliberate here even
where the repository's style would allow `var`: the point of the first read is
to see what is generated and what is parsed.

## The domain type

<!-- snippet: domain-type -->

```csharp
public sealed record Customer(int Id, string Name);
```

`Customer` is a `record` so `==` and `ShouldBe` compare values, not references.
If the production type is a class, give it value equality or compare a
documented projection in the law. A round-trip test that compares references
fails on every input and tells you nothing.

Equality must be value equality all the way down. A record holding a list or an
array still compares those members by reference; compare a documented snapshot
instead if that is the case.

The law also depends on the production pair it exercises — a `string
CustomerXml.Render(Customer customer)` and a `Customer CustomerXml.Parse(string
xml)`. They are omitted here because the page is about the test; a missing or
one-way pair is a production problem, not a property problem.

## The generator

<!-- snippet: generator -->

```csharp
using System.Collections.Generic;
using FsCheck;
using FsCheck.Fluent;

public static class CustomerArbitraries
{
    /// <summary>
    /// A representative customer from the documented XML contract: the name set
    /// the contract admits and an id from the positive range.
    /// </summary>
    public static Arbitrary<Customer> ValidCustomer()
    {
        Gen<string> name = Gen.Elements("Ada", "Grace", "Alan");
        Gen<int> id = Gen.Choose(1, 100_000);
        Gen<Customer> customer = from customerName in name
                                 from customerId in id
                                 select new Customer(customerId, customerName);
        return Arb.From(customer, ShrinkCustomer);
    }

    /// <summary>Shrinks the id to the documented minimum, staying inside the domain.</summary>
    private static IEnumerable<Customer> ShrinkCustomer(Customer customer)
    {
        if (customer.Id > 1)
        {
            yield return customer with { Id = 1 };
        }
    }
}
```

- `Arbitrary<Customer>` is the type FsCheck looks for when the method has a
  `Customer` parameter. `[Property(Arbitrary = [typeof(CustomerArbitraries)])]`
  registers it for the test method.
- `Gen<string>` and `Gen<int>` show the pieces; the query composes them into a
  `Customer`. The reader can see the documented domain without opening another
  file.
- `ValidCustomer` names the contract domain, not the type. If the contract also
  documents rejected values, a separate `InvalidCustomer` generator sits beside
  it and the test that expects rejection names that domain.
- The generator is registered at the method with the collection form
  `[Property(Arbitrary = [typeof(...)])]`. A class-level `[Properties]` is
  allowed only when the class is named for the domain it registers and every
  property uses it; never assembly-level.
- A generator with one consumer lives in the law file, below the laws. A domain
  used by more than one test class moves to
  `TestData/Arbitraries/<Domain>Arbitraries.cs`, named for the domain, not the
  test class or the CLR type. One arbitrary class may expose several types:
  FsCheck registers by return type, so a class per generated type is wrong.
- The name list is deliberately small to keep the page readable. A real
  generator follows the documented viable set, not a convenient sample.

Without the attribute's `typeof(...)`, FsCheck would invent a `Customer` from
its members. That is not the documented domain, so it does not prove the
contract.

## The shrinker

A generator must shrink. The shrunk counterexample is half the value of a
property: it turns "some input failed" into "the smallest input the contract
still rejects".

- `Arb.From(gen)` alone registers no shrinker — FsCheck's API says so — and a
  property built on it reports the first counterexample, not the minimal one.
  Use `Arb.From(gen, shrinker)`; the two-argument overload is the shape.
- The shrinker stays inside the documented domain. `ShrinkCustomer` above
  yields only ids the contract accepts, so minimising never invents an input the
  contract never promised.
- A composite shrinker is fine when the domain has several members, as long as
  every candidate it yields is still valid.
- A hand-rolled _sampling_ generator never shrinks. Generation plus the shrunk
  counterexample is the point.
- Where a boundary matters, test the generator: a domain property proves it
  stays inside the documented range, and a sample test proves it reaches both
  sides of the threshold. A generator that never reaches the boundary is a
  vacuous property.

## The seed

The seed is how a failing run is reproduced. It is routing, not evidence, and
it never appears in the law.

The suite does not pin a seed. FsCheck draws a fresh one on every run, local and
CI alike, and prints it with the shrunk case when a property fails.

A failure is a signal, not a flake: investigate it. Either the code is wrong,
the generator admits inputs the contract does not, or the law is too weak. Fix
that cause. Then record the seed and the promoted case so the same input guards
the suite forever. Pinning the seed to get green hides the defect and freezes
the sample; reproducibility comes from the printed seed and the recorded case,
not from a frozen run.

When a property fails, record the `(seed,gamma)` pair in a per-class ledger
beside the law, with the date, ticket and symptom:

<!-- snippet: seed-ledger -->

```csharp
public readonly record struct SeedCase(string Seed, DateOnly Found, string Ticket, string Symptom);

public static class CustomerXmlSeeds
{
    public static readonly TheoryDataRow<SeedCase>[] All =
    [
        new(new("1234567890,987654321", new DateOnly(2026, 11, 27), "AB#1234", "name uppercased"))
    ];
}
```

Replay every entry through the same law body from one `[Theory]` beside the
random properties. It needs `FsCheck`, `FsCheck.Fluent`, `Microsoft.FSharp.Core`,
`System.Globalization` and `Xunit`:

<!-- snippet: replay-theory -->

```csharp
    [Theory]
    [MemberData(nameof(CustomerXmlSeeds.All), MemberType = typeof(CustomerXmlSeeds))]
    public void RenderThenParse_WhenReplayingARecordedSeed_RestoresOriginal(SeedCase seed)
    {
        // Arrange
        string[] parts = seed.Seed.Split(',');
        ulong seedValue = ulong.Parse(parts[0], CultureInfo.InvariantCulture);
        ulong gamma = ulong.Parse(parts[1], CultureInfo.InvariantCulture);
        Replay replay = new(new Rnd(seedValue, gamma), null);
        Property law = Prop.ForAll(
            CustomerArbitraries.ValidCustomer(),
            (Customer original) => RoundTrips(CustomerXml.Render, CustomerXml.Parse, original));

        // Act / Assert
        Check.One(Config.QuickThrowOnFailure.WithReplay(FSharpOption<Replay>.Some(replay)), law);
    }
```

- `Replay` is `"seed,gamma"` and the gamma must be odd, because FsCheck rejects
  an even one. Parse both parts as `ulong` with `CultureInfo.InvariantCulture`:
  a printed seed can exceed `long.MaxValue`, and the pair is a wire format, not
  a locale. Record the two-element pair FsCheck prints first; a multi-test
  failure also prints a three-element last-step tuple, which adds the size and
  is not needed for this ledger.
- The ledger is `TheoryDataRow<SeedCase>[]` on xUnit v3. That is the house
  shape, and xunit.v3's xUnit1019 analyzer accepts it as `MemberData`. xUnit v2
  has no `TheoryDataRow`: use `TheoryData<SeedCase>` or
  `IEnumerable<object[]>` there. Never use `SeedCase[]`; xUnit cannot treat a
  plain struct array as `MemberData`.
- `Prop.ForAll` takes the `Arbitrary<T>` values, not their `.Generator`;
  `QuickThrowOnFailure` makes a replay failure throw so xUnit reports it.
- The property carries no `Replay`. A per-site literal freezes one property; the
  ledger holds every recorded seed and is the one place to add another.
- `RoundTrips` is the law body extracted from the `[Property]` method above, so
  the random property and the replay theory run the same assertions and a
  recorded seed cannot drift from the live law.
- The ledger sits beside the class it guards, not in `Support/` or a central
  list; a central list keyed by law name silently orphans entries on a rename.
- A ledger entry can go once a promoted example covers the same input and the
  law is unchanged. Otherwise the list grows without bound and stops being
  readable.

## The canary

A property can pass without being able to fail: a law written against the
implementation, a clause that is always true, or a predicate that ignores its
input. The canary proves the law can fail, and it is one `[Fact]` per law body.

<!-- snippet: canary -->

```csharp
    // Why use multi-statement-act here: the control and the mutant are the canary's two halves
    [Fact]
    public void RenderThenParse_WhenTheImplementationIsMutated_IsFalsified()
    {
        // Arrange
        Customer original = new(1, "Alan");

        // Act
        bool realRestores = RoundTrips(CustomerXml.Render, CustomerXml.Parse, original);
        bool uppercasingParseRestores = RoundTrips(CustomerXml.Render, UppercasingParse, original);

        // Assert
        realRestores.ShouldBeTrue("the control proves the real implementation satisfies the law");
        uppercasingParseRestores.ShouldBeFalse("the name clause must reject a parse that changes case");
    }

    /// <summary>Mutant: uppercases the name, so the name clause must reject it.</summary>
    private static Customer UppercasingParse(string xml)
    {
        Customer parsed = CustomerXml.Parse(xml);
        return parsed with { Name = parsed.Name.ToUpperInvariant() };
    }
```

- The control is not optional. An always-false law passes a canary that only
  asserts its mutants fail; the control proves the real implementation satisfies
  the law before the mutant is judged.
- Mutants are local functions with the production signature, or a corrupted
  output object where the production call cannot be substituted. Use one mutant
  per clause whose bite you want proven; more mutants than clauses adds runtime
  without proving another rule.
- Fixed, readable inputs only. Generated inputs would make the canary
  non-deterministic and duplicate the property's job.
- The canary sits beside the laws, is named
  `<Family>_WhenTheImplementationIsMutated_IsFalsified`, and docblocks each
  mutant with the clause it proves. The control and the mutant are one act with
  two halves, so the declaration carries a `multi-statement-act` why-note. A
  canary that passes against a mutant means the law is vacuous and the property
  is decoration.
- The canary is a hard gate for new and changed property laws: a property
  without a canary in the same class is not reviewable. Enforcement is
  review-only — nothing in the build can tell a missing canary from a class that
  legitimately has none, so do not describe it as automated.
- Mutation testing tools can complement the canary, but they do not replace a
  per-law guard that runs in the normal suite.

## Where the files live

```text
tests/
  CustomerXmlTests.cs                   named examples
  CustomerXmlPropertyTests.cs           laws, shared law body, generator, canary, replay theory
  CustomerXmlSeeds.cs                   the per-class seed ledger, beside the class it guards
  TestData/Arbitraries/
    CustomerArbitraries.cs              domains shared by more than one test class
```

- A property states a law that must hold for every input in a documented domain.
  An example test pins one named edge: a leap day, a hostile string, an exact
  boundary. Both are wanted, in the same folder and namespace.
- Always pair `<Subject>Tests.cs` and `<Subject>PropertyTests.cs` when the
  subject has both examples and laws. A subject with only one kind uses the one
  file. No size judgement, and the generator is not a split reason.
- One subject per property class, and one contract level. Do not mix a pure rule
  with a whole-service transform in one class; a failure must name which
  contract broke.
- Order inside the law file: class docblock, fixtures, properties grouped by
  production method, private helpers including the shared law body, the
  single-consumer generator, then the canary and the replay theory. The ledger
  file sits beside the class it guards.
- The shared folder is for domains, not for convenience. A generator with one
  consumer stays in the law file; only a domain that more than one class
  generates belongs in `TestData/Arbitraries/`.

The split is the readability rule made physical. A reader who opens
`CustomerXmlPropertyTests.cs` sees the laws, the shared body, the generator, the
canary and the replay theory; the named examples stay readable beside it.

## Docblocks

The smallest addition with the biggest read: a reviewer should not have to open
the implementation to understand the law, the domain or the canary.

- **Class docblock**: the law family, the ticket, and what the examples keep.
  The ticket lives here, not in the method name.
- **Each law**: one short summary stating the law and the domain. Never restate
  the method name.
- **Each generator member**: the domain it covers and why the boundary sits
  there. A magic spread becomes a named constant, because a reader cannot tell a
  range from a bug.
- **Each canary mutant**: the clause it proves.
- **Each ledger entry**: the seed, the date found, the ticket and a one-line
  symptom. The `SeedCase` fields carry them, so no separate comment is needed.

The worked shapes above show all five categories: the class summary, the law
summary and the `RoundTrips` summary, the two generator member summaries, the
mutant summary and the populated `SeedCase`.

## What a failure looks like

A deliberate defect in `Parse` (uppercasing the name) produces something like:

```text
Falsifiable, after 1 test (1 shrink) (1234567890,987654321).
Original:
Customer { Id = 35276, Name = Alan }
Shrunk:
Customer { Id = 1, Name = Alan }

Shouldly.ShouldAssertException : restored
    render then parse must restore Customer { Id = 1, Name = Alan }
    should be
True
    but was
False
```

This run stopped after one case because the first generated value already
failed; FsCheck then shrank it to the smallest failing customer, and a healthy
run completes all 100 cases (the test runner still reports one test method). The
seed is drawn per run; the failure prints it.

Read it in three parts:

1. **the replay** — `(1234567890,987654321)` is the seed and gamma. Record the
   pair in the ledger; the replay theory runs the same law from it.
2. **the failing input** — `Original:` is the first failing case; `Shrunk:` is
   the smallest case that still fails: the id at the documented minimum. The
   promoted example below uses `Id = 1`.
3. **the assertion** — the law's message and the counterexample, not a generic
   "property failed".

The bool law body does not print both values the way a `ShouldBe` diff does, so
the interpolated message carries the counterexample. The canary is what says
which clause the shrunk case broke.

Then promote the shrunk case into a plain `[Fact]` in `CustomerXmlTests.cs`, the
example file beside the property. The example is readable without FsCheck, fails
against the pre-fix code, and does not depend on a generator or a seed. The
ledger keeps the exact input replayable; the named example is the durable
regression evidence.

<!-- snippet: promoted-example -->

```csharp
    // Promoted from the failure: a mixed-case name must survive the round trip.
    [Fact]
    public void RenderThenParse_WithMixedCaseName_RestoresOriginal()
    {
        // Arrange
        Customer original = new Customer(1, "Alan");

        // Act
        Customer reparsed = CustomerXml.Parse(CustomerXml.Render(original));

        // Assert
        reparsed.ShouldBe(original);
    }
```

## When a property is the right tool

Reach for a property when the contract states a law rather than a list:

- the contract says **always**, **never**, **every**, **no more than**,
  **round trip**, **sorted**, **unique**, or **reconciles**;
- a format/parse, serialise/deserialise, or encode/decode pair both appear —
  that pair gets a round-trip property;
- two example tests differ only in their data;
- an example table would need four or more rows to cover the range.

A finite documented domain can be enumerated exhaustively without FsCheck —
every port, every status pair. Completeness is the property there, so you do
not need shrinking.

Keep named examples where the contract is a list of cases: permissions, status
transitions, error mapping. If a trigger fires and a property is not the right
instrument, leave a why-not note immediately above the test declaration — the
gate reads only the contiguous comment block above it:

```csharp
// Why not use property here: the contract is a fixed list of status transitions
```

Silence is the failure mode; the note is the decision.

A law that exists only in the implementation is `[NEEDS DECISION]`, not a
property. Surface it to the owner; do not let a generated test settle it.

## Where this is enforced

- This page is the creation shape; [`test-review.md`](test-review.md) is the
  review catalogue. The review pass judges a property against the shape above.
- The C# shapes above compile and run in `docs/fixtures/property-testing/`, and
  `runtime/lib/property-testing-snippets.test.mts` fails the gate when a marked
  snippet and its compiled fixture diverge.
- The `unrouted-property-seed` review rule enforces the no-frozen-seed half: it
  reports a numeric fast-check `seed:` literal, a C# `Replay = "<literal>"` with
  no `$` interpolation, and an even replay gamma. It runs in the
  `defined scan --files` review pass, not in `verify` or `comply`.
- The shrinker, the seed ledger and the canary are review-only. No gate rule can
  see a missing shrinker, an unrecorded seed or an absent canary; reviewers hold
  that line.
- The gate does not yet read a `[Property]` as a test declaration, so the
  always-on hygiene rules do not inspect these bodies. Treat the shape above as
  the review baseline until that lands.
