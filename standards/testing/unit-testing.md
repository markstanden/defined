# C# testing standards (xUnit)

Reviewer and agent guidance. The `defined` gate runs `dotnet
format/build/test`; it does **not** enforce these structures, names or patterns —
treat this as the agreed convention for reviews and agent work, not a
mechanically-checked contract.

**Stack**: xUnit, Moq, Shouldly.

## Test class shape

```csharp
public class TrainingPeaksHistoryServiceTests
{
    private const string ValidEntraId = "user@example.com";

    private readonly Mock<IUserRepository> _mockUserRepository = new();
    private readonly Mock<IRunHistoryTransformer> _mockTransformer = new();

    private readonly TrainingPeaksHistoryService _sut;

    public TrainingPeaksHistoryServiceTests()
    {
        _sut = new TrainingPeaksHistoryService(_mockUserRepository.Object, _mockTransformer.Object);
    }
}
```

- `[ClassName]Tests` names the class under test; `_sut` is the System Under Test.
- Constants for magic strings and values sit above the mocks — in practice there
  are few, thanks to parameterisation.
- Mock fields are `_mock` plus the dependency name without its `I` prefix, always
  `private readonly`, declared above `_sut`.
- Inject mocks via `.Object` in an explicitly `public` constructor. Prefer a real
  implementation (a hand-rolled fake, a simple value object, a genuine
  collaborator) when mocking would obscure the test — the goal is an honest
  test, not maximal mocking.

## Test methods

Name them `[MethodName]_[Condition]_[ExpectedBehaviour]` —
`AddRunHistory_WithValidData_ReturnsExpectedRowCount`. Existing methods keep an
American `_Behavior` suffix; new tests use `Behaviour`.

Structure every test with `// Arrange`, `// Act`, `// Assert` comments, and
verify exactly one behaviour per test. Use `[Theory]` with `[InlineData]` to run
the same logic across values:

```csharp
[Theory]
[InlineData("")]
[InlineData("   ")]
[InlineData(null)]
public async Task AddRunHistory_WithInvalidEntraId_ThrowsArgumentException(string? invalidEntraId)
{
    // Arrange
    string validCsv = new TrainingPeaksCsvBuilder().Build();

    // Act
    var withInvalidEntraId = async () => await _sut.AddRunHistory(invalidEntraId!, validCsv);

    // Assert
    Exception ex = await withInvalidEntraId.ShouldThrowAsync<ArgumentException>();
    ex.Message.ShouldContain("entraId");
}
```

- **Async**: use `async Task` and `await` when the code under test is
  asynchronous; keep the test synchronous when it is not.
- **Exceptions**: name the lambda descriptively (`withInvalidEntraId`,
  `withNullData`), assert with `Should.Throw`/`ShouldThrowAsync`, and always
  assert the message contains the expected text.

## Mocking

- Every `Setup` belongs in Arrange, before Act.
- `It.IsAny<T>()` when the specific value does not matter; a specific value when
  the test is about the exact argument passed.
